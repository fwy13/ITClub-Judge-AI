import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import axios from 'axios';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, rm, copyFile, stat, readdir, statfs, open, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {parse as parseCsv} from 'csv-parse/sync';
import { normalizeMetricScore, perfectScoreForMetric, scoreScale } from './scoring.js';
import { contestAcceptsSubmissions, contestProblemLabel, effectiveContestStatus, roleCanEnterContest } from './contest-rules.js';
import { normalizeProblemText, publicStarter } from './problem-rules.js';
import { countGeminiTokens, streamGeminiResponse } from './gemini-client.js';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) throw Error('JWT_SECRET must be at least 32 characters');
const app = express();
app.disable('x-powered-by'); app.use(helmet()); app.use(express.json({ limit: '300kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, standardHeaders: 'draft-7', legacyHeaders: false }));
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024, files: 1, fields: 0 } });
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });
const sockets = new Map();
const queue = []; let active = 0; const MAX_ACTIVE = 2; const MAX_QUEUE = 200;
const workerUrl = process.env.RUST_WORKER_URL || 'http://rust-worker:3001';
const csvUrl = process.env.CSV_JUDGE_URL || 'http://csv-judge:8100';
const geminiApiKey = String(process.env.GEMINI_API_KEY || '').trim();
const geminiModel = String(process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
const chatTokenLimit = Math.min(100000, Math.max(100, Number.parseInt(process.env.CHAT_TOKEN_LIMIT || '2000', 10) || 2000));
const publicProblem = p => ({
    slug: p.slug,
    title: p.title,
    category: p.category,
    difficulty: p.difficulty,
    kind: p.kind,
    description: normalizeProblemText(p.description),
    starter: publicStarter(p),
    metric: p.metric,
    greater_is_better: p.kind === 'csv' ? Boolean(p.config?.greater_is_better) : null,
    baseline_score: p.kind === 'csv' ? scoreScale(p)?.baseline ?? null : null,
    perfect_score: p.kind === 'csv' ? scoreScale(p)?.perfect ?? null : null,
    sample_tests: (p.tests || []).slice(0, 1).map(t => ({ args: t.args, expected: t.expected })),
});
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const tokenFor = user => jwt.sign({ id: user.id, username: user.username, role: user.role || 'student' }, secret, { expiresIn: '12h', issuer: 'itclub-judge' });
const verify = token => jwt.verify(token, secret, { issuer: 'itclub-judge' });
async function profileFor(id) {
    const q = await pool.query(`SELECT u.id,u.username,u.email,u.role,u.avatar,u.created_at,
        COUNT(DISTINCT s.problem_slug) FILTER(WHERE s.status='accepted')::int AS solved,
        COUNT(s.id)::int AS attempts
        FROM users u LEFT JOIN submissions s ON s.user_id=u.id WHERE u.id=$1 GROUP BY u.id`, [id]);
    return q.rows[0] || null;
}
async function publicProfileFor(username) {
    const q = await pool.query(`SELECT u.username,u.avatar,u.created_at,
        COUNT(DISTINCT s.problem_slug) FILTER(WHERE s.status='accepted')::int AS solved,
        COUNT(s.id)::int AS attempts
        FROM users u LEFT JOIN submissions s ON s.user_id=u.id WHERE u.username=$1 GROUP BY u.id`, [username]);
    return q.rows[0] || null;
}
function auth(req, res, next) { try { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); req.user = verify(t); next() } catch { res.status(401).json({ error: 'Authentication required' }) } }
function optionalAuth(req, _res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (token) { try { req.user = verify(token); } catch { req.user = null; } }
    next();
}
async function admin(req, res, next) {
    try { const q = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]); if (q.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' }); next() } catch (e) { next(e) }
}
async function team(req, res, next) {
    try { const q = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]); if (q.rows[0]?.role !== 'team') return res.status(403).json({ error: 'A team account is required for the chatbot' }); next() } catch (e) { next(e) }
}
function chatSessionPayload(row) {
    const tokenLimit = Number(row.token_limit);
    const tokensUsed = Number(row.tokens_used);
    return {
        id: row.id,
        title: row.title,
        token_limit: tokenLimit,
        tokens_used: tokensUsed,
        remaining_tokens: Math.max(0, tokenLimit - tokensUsed),
        generating: Boolean(row.generating),
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}
function chatTitle(message) {
    const compact = String(message).replace(/\s+/g, ' ').trim();
    return compact.slice(0, 72) || 'New chat';
}
function sendChatEvent(res, payload) {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function send(socket, payload) { if (socket.readyState === 1) socket.send(JSON.stringify(payload)) }
function broadcast(id, event) { for (const ws of sockets.get(id) || []) send(ws, event) }
function subscribe(ws, id) { let s = sockets.get(id); if (!s) { s = new Set(); sockets.set(id, s) } s.add(ws); ws._subscriptions.add(id) }
async function getSubmission(id, uid) {
    const q = await pool.query(`SELECT s.id,s.problem_slug,s.kind,s.status,s.passed,s.total,s.normalized_score,
        CASE WHEN s.kind='code' AND s.total>0 THEN s.passed::double precision*100/s.total ELSE s.score END AS score,
        CASE WHEN s.kind='code' THEN 'AC rate' ELSE s.metric END AS metric,s.results,s.error,s.created_at,c.slug AS contest_slug
        FROM submissions s LEFT JOIN contests c ON c.id=s.contest_id WHERE s.id=$1 AND s.user_id=$2`, [id, uid]);
    return q.rows[0] || null;
}
wss.on('connection', ws => {
    ws._subscriptions = new Set();
    ws.on('message', async raw => {
        try {
            const m = JSON.parse(String(raw)); if (m.type !== 'subscribe' || !m.submission_id || !m.token) return send(ws, { type: 'error', message: 'Expected subscribe message with token and submission_id' });
            const user = verify(m.token); const sub = await getSubmission(m.submission_id, user.id); if (!sub) return send(ws, { type: 'error', message: 'Submission not found' });
            subscribe(ws, sub.id); send(ws, { type: 'snapshot', submission: sub });
        } catch { send(ws, { type: 'error', message: 'Authorization or subscription failed' }) }
    });
    ws.on('close', () => { for (const id of ws._subscriptions) { sockets.get(id)?.delete(ws); if (!sockets.get(id)?.size) sockets.delete(id) } });
});
async function update(id, changes, type = 'progress') {
    const cols = Object.keys(changes); const values = Object.values(changes);
    const setters = cols.map((k, i) => `${k}=$${i + 1}`).join(',');
    await pool.query(`UPDATE submissions SET ${setters} WHERE id=$${cols.length + 1}`, [...values, id]);
    broadcast(id, { type, submission_id: id, ...changes });
}
function enqueue(job) { if (queue.length >= MAX_QUEUE) return false; queue.push(job); setImmediate(pump); return true }
function pump() { while (active < MAX_ACTIVE && queue.length) { active++; const job = queue.shift(); Promise.resolve().then(job).catch(e => console.error('job failure', e)).finally(() => { active--; pump() }) } }
async function gradeCode(id, problem, code) {
    const tests = problem.tests; const results = []; let passed = 0;
    for (let i = 0; i < tests.length; i++) {
        try {
            const response = await axios.post(workerUrl + '/internal/execute', {
                code,
                function: problem.function,
                ...(problem.class_name ? { class_name: problem.class_name } : {}),
                tests: [tests[i]],
                time_limit_ms: 12000,
                memory_limit_mb: 2048,
            }, { timeout: 30000 });
            const t = response.data.tests?.[0] || {};
            const status = t.status || 'runtime_error'; if (status === 'accepted') passed++;
            // Never reveal hidden expected or actual output. First case is public sample.
            results.push({ index: i, status, ...(i === 0 ? { actual: t.actual, expected: t.expected, error: t.error } : {}) });
        } catch (e) {
            const message = e.response?.data?.error || e.message;
            results.push({ index: i, status: 'runtime_error', ...(i === 0 ? { error: String(message).slice(0, 500) } : {}) });
        }
        await update(id, { passed, total: tests.length, score: tests.length ? passed * 100 / tests.length : 0, metric: 'AC rate', results: JSON.stringify(results), status: 'running' }, 'test_completed');
    }
    await update(id, { status: passed === tests.length ? 'accepted' : 'failed', passed, total: tests.length, score: tests.length ? passed * 100 / tests.length : 0, metric: 'AC rate', results: JSON.stringify(results) }, 'completed');
}
async function gradeCsv(id, problem, buffer) {
    try {
        const { data } = await axios.post(csvUrl + '/grade/' + encodeURIComponent(problem.slug), buffer, { headers: { 'Content-Type': 'text/csv', 'X-Internal-Key': process.env.CSV_INTERNAL_KEY }, timeout: 120000, maxBodyLength: 12 * 1024 * 1024 });
        const normalizedScore = data.status === 'accepted' ? normalizeMetricScore(data.score, problem) : null;
        await update(id, { status: data.status === 'accepted' ? 'accepted' : 'failed', score: data.score ?? null, normalized_score: normalizedScore, metric: data.metric ?? null, error: data.message ?? null, results: JSON.stringify([{ ...data, normalized_score: normalizedScore }]), passed: data.status === 'accepted' ? 1 : 0, total: 1 }, 'completed');
    } catch (e) { await update(id, { status: 'failed', error: String(e.response?.data?.detail || e.message).slice(0, 500) }, 'completed') }
}
const seededProblems = JSON.parse(await readFile(new URL('./problems.json', import.meta.url), 'utf8'));
async function listProblems() {
    const q = await pool.query(`SELECT p.data,COUNT(s.id)::int AS submissions,COUNT(DISTINCT s.user_id)::int AS participants
        FROM problems p LEFT JOIN submissions s ON s.problem_slug=p.slug
        WHERE p.active=true AND NOT EXISTS (
            SELECT 1 FROM contest_problems cp JOIN contests c ON c.id=cp.contest_id
            WHERE cp.problem_slug=p.slug AND (c.status='closed' OR (c.status='open' AND c.end_at>now()))
        ) GROUP BY p.slug,p.data,p.created_at ORDER BY p.created_at DESC,p.slug DESC`);
    return q.rows;
}
async function findProblem(slug) {
    const q = await pool.query(`SELECT p.data FROM problems p WHERE p.slug=$1 AND p.active=true AND NOT EXISTS (
        SELECT 1 FROM contest_problems cp JOIN contests c ON c.id=cp.contest_id
        WHERE cp.problem_slug=p.slug AND (c.status='closed' OR (c.status='open' AND c.end_at>now()))
    )`, [slug]);
    return q.rows[0]?.data || null;
}

async function syncExpiredContests() {
    await pool.query("UPDATE contests SET status='ended',updated_at=now() WHERE status='open' AND end_at<=now()");
}

const contestView = row => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    type: row.type,
    duration_minutes: row.duration_minutes,
    status: effectiveContestStatus(row),
    start_at: row.start_at,
    end_at: row.end_at,
    created_at: row.created_at,
    problem_count: Number(row.problem_count || 0),
    participant_count: Number(row.participant_count || 0),
    joined: Boolean(row.joined),
});

async function contestForSlug(slug, userId = null) {
    await syncExpiredContests();
    const q = await pool.query(`SELECT c.*,
        COUNT(DISTINCT cp.problem_slug)::int AS problem_count,
        COUNT(DISTINCT all_participants.user_id)::int AS participant_count,
        BOOL_OR(joined.user_id IS NOT NULL) AS joined
        FROM contests c
        LEFT JOIN contest_problems cp ON cp.contest_id=c.id
        LEFT JOIN contest_participants all_participants ON all_participants.contest_id=c.id
        LEFT JOIN contest_participants joined ON joined.contest_id=c.id AND joined.user_id=$2
        WHERE c.slug=$1 GROUP BY c.id`, [slug, userId]);
    return q.rows[0] || null;
}

async function contestProblem(contestId, problemSlug) {
    const q = await pool.query(`SELECT p.data,cp.position,cp.label FROM contest_problems cp
        JOIN problems p ON p.slug=cp.problem_slug WHERE cp.contest_id=$1 AND cp.problem_slug=$2`, [contestId, problemSlug]);
    return q.rows[0] || null;
}

async function currentUserRole(userId) {
    const q = await pool.query('SELECT role FROM users WHERE id=$1', [userId]);
    return q.rows[0]?.role || null;
}

function canReadContestProblems(contest, user) {
    const status = effectiveContestStatus(contest);
    return status === 'ended' || user?.role === 'admin' || (status === 'open' && contest.joined);
}

async function submissionProblem(user, slug, kind, contestSlug) {
    if (!contestSlug) {
        const problem = await findProblem(slug);
        if (!problem || problem.kind !== kind) throw Object.assign(Error('Invalid or unavailable problem'), { statusCode: 400 });
        return { problem, contestId: null };
    }
    const role = await currentUserRole(user.id);
    const contest = await contestForSlug(contestSlug, user.id);
    if (!contest) throw Object.assign(Error('Contest not found'), { statusCode: 404 });
    if (!roleCanEnterContest(contest.type, role)) throw Object.assign(Error('This account type cannot enter this contest'), { statusCode: 403 });
    if (!contest.joined) throw Object.assign(Error('Enter the contest password before submitting'), { statusCode: 403 });
    if (!contestAcceptsSubmissions(contest)) throw Object.assign(Error('Contest has ended. New submissions are no longer accepted.'), { statusCode: 409 });
    const attached = await contestProblem(contest.id, slug);
    if (!attached || attached.data.kind !== kind || contest.type !== kind) throw Object.assign(Error('Problem is not part of this contest'), { statusCode: 400 });
    return { problem: attached.data, contestId: contest.id };
}
const csvRoot = process.env.CSV_PROBLEMS_DIR || '/data/csv-problems';
const uploadTmp = process.env.DATASET_UPLOAD_TMP || '/tmp/itclub-dataset-uploads';
const datasetMaxMb = Math.min(1024, Math.max(10, Number(process.env.DATASET_MAX_MB) || 100));
const datasetMaxBytes = datasetMaxMb * 1024 * 1024;
const bundledCsvRoot = '/csv-bundled-problems';
const PUBLIC_DATA_FILES = Object.freeze({
    train: { filename: 'train.csv', field: 'train_data', label: 'Training data', contentType: 'text/csv' },
    test: { filename: 'test.csv', field: 'test_data', label: 'Test data', contentType: 'text/csv' },
    sample_submission: { filename: 'sample_submission.csv', field: 'sample_submission', label: 'Sample submission', contentType: 'text/csv' },
    bundle: { filename: 'data.zip', field: 'data_bundle', label: 'Competition data bundle', contentType: 'application/zip' },
});
const PRIVATE_DATA_FILES = Object.freeze({
    ground_truth: { filename: 'ground_truth.csv', field: 'ground_truth' },
    config: { filename: 'config.json', field: null },
});
const ALL_CHALLENGE_FILENAMES = new Set([
    ...Object.values(PUBLIC_DATA_FILES).map(file => file.filename),
    ...Object.values(PRIVATE_DATA_FILES).map(file => file.filename),
]);
const csvMetrics = { binary_probability: ['log_loss', 'accuracy', 'f1', 'precision', 'recall', 'balanced_accuracy'], multiclass_label: ['accuracy', 'macro_f1'], multiclass_probability: ['log_loss', 'accuracy', 'macro_f1', 'macro_precision', 'macro_recall'], multilabel_probability: ['micro_f1', 'macro_f1', 'hamming_loss'], regression: ['rmse', 'mae', 'mse', 'r2', 'mape', 'smape'], ranking: ['ndcg_at_k', 'mrr', 'map', 'recall_at_k'], text_generation: ['sacrebleu', 'chrf'] };
const legacyCompetitionBaselines = Object.freeze({
    'bank-deposit-propensity': 0.43388528917686586,
    'dry-bean-vision-features': 0.8128379591619702,
    'wine-quality-regression': 0.743091088339953,
});
const validateSlug = s => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 80;
// Older bundled challenges use underscores. Keep their paths manageable while
// requiring the stricter hyphenated format for newly authored problems.
const validatePathSlug = s => typeof s === 'string' && /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(s) && s.length <= 80;
const validText = (s, max = 10000) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
function challengeDir(root, slug) {
    if (!validatePathSlug(slug)) throw Error('Invalid problem slug');
    const resolvedRoot = path.resolve(root);
    const candidate = path.resolve(resolvedRoot, slug);
    if (path.dirname(candidate) !== resolvedRoot) throw Error('Unsafe problem path');
    return candidate;
}
async function regularFileInfo(filePath) {
    try {
        const info = await stat(filePath);
        return info.isFile() ? info : null;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}
async function publicDataFiles(slug) {
    const files = [];
    for (const [key, definition] of Object.entries(PUBLIC_DATA_FILES)) {
        for (const root of [csvRoot, bundledCsvRoot]) {
            const filePath = path.join(challengeDir(root, slug), definition.filename);
            const info = await regularFileInfo(filePath);
            if (info) {
                files.push({ key, name: definition.filename, label: definition.label, size: info.size, content_type: definition.contentType });
                break;
            }
        }
    }
    return files;
}
async function locatePublicDataFile(slug, key) {
    const definition = PUBLIC_DATA_FILES[key];
    if (!definition) return null;
    for (const root of [csvRoot, bundledCsvRoot]) {
        const filePath = path.join(challengeDir(root, slug), definition.filename);
        const info = await regularFileInfo(filePath);
        if (info) return { ...definition, path: filePath, size: info.size };
    }
    return null;
}
async function challengeFileSummary(slug) {
    const dir = challengeDir(csvRoot, slug);
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const files = [];
    for (const entry of entries) {
        if (!entry.isFile() || !ALL_CHALLENGE_FILENAMES.has(entry.name)) continue;
        const info = await stat(path.join(dir, entry.name));
        files.push({ name: entry.name, size: info.size, public: Object.values(PUBLIC_DATA_FILES).some(file => file.filename === entry.name) });
    }
    return { files, bytes: files.reduce((total, file) => total + file.size, 0) };
}
function parseJson(v) { if (typeof v === 'object' && v !== null) return v; try { return JSON.parse(v || '') } catch { return null } }
// Each nonempty line is a positional argument. JSON literals are accepted for
// structured values; other text is interpreted as an ordinary string.
function parsePlainValue(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    try { return JSON.parse(text) } catch { return text }
}
function testFromText(input, output) {
    if (typeof input !== 'string' || typeof output !== 'string' || !output.trim()) throw Error('Test input and expected output must be text');
    if (input.length > 12000 || output.length > 12000) throw Error('Input/output text too long');
    return {args: input.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim()).map(parsePlainValue), expected: parsePlainValue(output)};
}
function problemFields(body) {
    const slug = String(body.slug || ''), title = String(body.title || ''), description = normalizeProblemText(body.description), kind = body.kind;
    if (!validateSlug(slug) || !validText(title, 160) || !validText(description, 12000) || !['code', 'csv'].includes(kind)) throw Error('Invalid slug, title, description or type');
    const difficulty = ['Easy', 'Medium', 'Hard'].includes(body.difficulty) ? body.difficulty : 'Medium';
    const base = { slug, title, description, kind, difficulty, category: String(body.category || 'General').slice(0, 80) };
    if (kind === 'code') {
        const rawTests = parseJson(body.tests); const tests = Array.isArray(rawTests) ? rawTests.map(t => t && typeof t.input === 'string' ? testFromText(t.input, t.output) : t) : null; if (!Array.isArray(tests) || tests.length < 1 || tests.length > 100 || !tests.every(t => t && Array.isArray(t.args) && Object.hasOwn(t, 'expected'))) throw Error('Tests must be an array (1–100) of {args, expected}');
        if (JSON.stringify(tests).length > 100000) throw Error('Test cases exceed 100 KB');
        if (!validText(body.function, 100) || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(body.function)) throw Error('Invalid function name');
        if (body.class_name && !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(body.class_name)) throw Error('Invalid class name');
        return { ...base, starter: normalizeProblemText(body.starter).slice(0, 20000), function: body.function, class_name: body.class_name || null, tests };
    }
    const config = parseJson(body.config); if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('CSV configuration must be JSON');
    if (!csvMetrics[config.task_type]?.includes(config.metric)) throw Error('Unsupported task_type or metric');
    if (!validText(config.id_column, 100) || !Array.isArray(config.prediction_columns) || !config.prediction_columns.length || !config.prediction_columns.every(x => validText(x, 100))) throw Error('Invalid CSV column configuration');
    if (config.task_type === 'ranking' && !validText(config.item_column, 100)) throw Error('Ranking needs item_column');
    if (!validText(config.target_column, 100)) throw Error('target_column is required');
    const baselineScore = Number(config.baseline_score);
    const perfectScore = perfectScoreForMetric(config.metric);
    if (!Number.isFinite(baselineScore)) throw Error('baseline_score must be a finite number measured from the provided baseline');
    if (!Number.isFinite(perfectScore)) throw Error('No perfect score is registered for this metric');
    if ((config.greater_is_better && baselineScore >= perfectScore) || (!config.greater_is_better && baselineScore <= perfectScore)) throw Error('baseline_score must be worse than the perfect score for this metric');
    return { ...base, starter: '', tests: [], metric: config.metric, config: { ...config, baseline_score: baselineScore, perfect_score: perfectScore, version: 1, max_file_size_mb: 10, max_rows: Math.min(100000, Math.max(1, Number(config.max_rows) || 100000)) } };
}

async function refreshNormalizedScores(problem) {
    const scale = scoreScale(problem);
    if (!scale) return;
    await pool.query(`UPDATE submissions
        SET normalized_score=LEAST(100.0,GREATEST(0.0,(score-$2)/($3-$2)*100.0))
        WHERE problem_slug=$1 AND kind='csv' AND score IS NOT NULL`, [problem.slug, scale.baseline, scale.perfect]);
}

async function initialize() {
    await mkdir(uploadTmp, { recursive: true, mode: 0o700 });
    await mkdir(csvRoot, { recursive: true, mode: 0o755 });
    // The API and CSV judge run as different unprivileged users while sharing
    // this volume. Repair permissions from older releases before serving jobs.
    await chmod(csvRoot, 0o755);
    for (const entry of await readdir(csvRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !validatePathSlug(entry.name)) continue;
        const dir = challengeDir(csvRoot, entry.name);
        await chmod(dir, 0o755);
        for (const file of await readdir(dir, { withFileTypes: true })) {
            if (file.isFile()) await chmod(path.join(dir, file.name), 0o644);
        }
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS users(id UUID PRIMARY KEY,username VARCHAR(40) NOT NULL UNIQUE,email VARCHAR(255) NOT NULL UNIQUE,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'student'");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT");
    await pool.query(`CREATE TABLE IF NOT EXISTS problems(slug VARCHAR(80) PRIMARY KEY,data JSONB NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    for (const p of seededProblems) { await pool.query('INSERT INTO problems(slug,data) VALUES($1,$2::jsonb) ON CONFLICT(slug) DO NOTHING', [p.slug, JSON.stringify(p)]) }
    await pool.query(`UPDATE problems SET data=jsonb_set(data,'{description}',to_jsonb(replace(data->>'description',$2,$3)),false),updated_at=now()
        WHERE slug=$1 AND data->>'description' LIKE '%' || $2 || '%'`, [
        'oxford-pets-cat-dog',
        'https://drive.google.com/file/d/1A7yj4NVrq68FR-ow6shdGT9K1CM5KODK/view?usp=sharing',
        'https://drive.google.com/drive/folders/1F2Cu8tAJIjTbhAXMjG5jh1wHH8PXKldb?usp=sharing',
    ]);
    for (const [slug, baseline] of Object.entries(legacyCompetitionBaselines)) {
        const problem = await pool.query('SELECT data FROM problems WHERE slug=$1', [slug]);
        if (!problem.rowCount || problem.rows[0].data.kind !== 'csv') continue;
        const metric = problem.rows[0].data.config?.metric || problem.rows[0].data.metric;
        const perfect = perfectScoreForMetric(metric);
        if (!Number.isFinite(perfect)) continue;
        await pool.query(`UPDATE problems SET data=jsonb_set(jsonb_set(data,'{config,baseline_score}',to_jsonb($2::double precision),true),'{config,perfect_score}',to_jsonb($3::double precision),true)
            WHERE slug=$1 AND data#>>'{config,baseline_score}' IS NULL`, [slug, baseline, perfect]);
    }
    const adminUsername = process.env.ADMIN_BOOTSTRAP_USERNAME; const adminPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (adminUsername && adminPassword) {
        if (!/^[a-zA-Z0-9_]{3,40}$/.test(adminUsername) || adminPassword.length < 16) throw Error('Invalid admin bootstrap settings');
        const r = await pool.query('SELECT role FROM users WHERE username=$1', [adminUsername]);
        if (!r.rowCount) { await pool.query('INSERT INTO users(id,username,email,password_hash,role) VALUES($1,$2,$3,$4,$5)', [randomUUID(), adminUsername, `${adminUsername.toLowerCase()}@local.invalid`, await bcrypt.hash(adminPassword, 12), 'admin']); console.log('Administrator account created'); }
        else if (r.rows[0].role !== 'admin') throw Error('ADMIN_BOOTSTRAP_USERNAME conflicts with a non-admin account');
    }

    await pool.query(`CREATE TABLE IF NOT EXISTS contests(
        id UUID PRIMARY KEY,slug VARCHAR(80) NOT NULL UNIQUE,title VARCHAR(160) NOT NULL,description TEXT NOT NULL DEFAULT '',
        type VARCHAR(10) NOT NULL CHECK(type IN ('code','csv')),password_hash TEXT NOT NULL,duration_minutes INT NOT NULL CHECK(duration_minutes BETWEEN 5 AND 10080),
        status VARCHAR(12) NOT NULL DEFAULT 'closed' CHECK(status IN ('closed','open','ended')),
        start_at TIMESTAMPTZ,end_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query('ALTER TABLE contests DROP CONSTRAINT IF EXISTS contests_status_check');
    await pool.query("UPDATE contests SET status='closed' WHERE status='draft'");
    await pool.query("ALTER TABLE contests ALTER COLUMN status SET DEFAULT 'closed'");
    await pool.query("ALTER TABLE contests ADD CONSTRAINT contests_status_check CHECK(status IN ('closed','open','ended'))");
    await pool.query(`CREATE TABLE IF NOT EXISTS contest_problems(
        contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,problem_slug VARCHAR(80) NOT NULL REFERENCES problems(slug) ON DELETE RESTRICT,
        position INT NOT NULL,label VARCHAR(8) NOT NULL,PRIMARY KEY(contest_id,problem_slug),UNIQUE(contest_id,position),UNIQUE(contest_id,label))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS contest_participants(
        contest_id UUID NOT NULL REFERENCES contests(id) ON DELETE CASCADE,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(contest_id,user_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS chat_sessions(
        id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,title VARCHAR(120) NOT NULL DEFAULT 'New chat',
        token_limit INT NOT NULL DEFAULT 2000 CHECK(token_limit BETWEEN 100 AND 100000),tokens_used INT NOT NULL DEFAULT 0 CHECK(tokens_used >= 0),
        generating BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages(
        id UUID PRIMARY KEY,ordinal BIGSERIAL UNIQUE,session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role VARCHAR(8) NOT NULL CHECK(role IN ('user','model')),content TEXT NOT NULL,token_count INT NOT NULL DEFAULT 0 CHECK(token_count >= 0),
        finish_reason VARCHAR(40),created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query('ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS ordinal BIGSERIAL');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_sessions_user_idx ON chat_sessions(user_id,updated_at DESC)');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_ordinal_idx ON chat_messages(ordinal)');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_messages_session_idx ON chat_messages(session_id,ordinal)');
    await pool.query('UPDATE chat_sessions SET generating=FALSE WHERE generating=TRUE');
    await pool.query(`CREATE TABLE IF NOT EXISTS submissions(id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id),problem_slug VARCHAR(100) NOT NULL,kind VARCHAR(10) NOT NULL,status VARCHAR(30) NOT NULL DEFAULT 'queued',code TEXT,passed INT NOT NULL DEFAULT 0,total INT NOT NULL DEFAULT 0,score DOUBLE PRECISION,metric VARCHAR(100),results JSONB NOT NULL DEFAULT '[]'::jsonb,error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query('ALTER TABLE submissions ADD COLUMN IF NOT EXISTS normalized_score DOUBLE PRECISION');
    await pool.query('ALTER TABLE submissions ADD COLUMN IF NOT EXISTS contest_id UUID REFERENCES contests(id) ON DELETE SET NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS submissions_user_id_idx ON submissions(user_id,created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS submissions_problem_score_idx ON submissions(problem_slug,user_id,status,score,created_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS submissions_contest_idx ON submissions(contest_id,user_id,problem_slug,created_at DESC)');
    const csvProblems = await pool.query("SELECT data FROM problems WHERE data->>'kind'='csv'");
    for (const row of csvProblems.rows) await refreshNormalizedScores(row.data);
}
app.get('/api/health', (_req, res) => res.json({ status: 'ok', services: ['auth-api', 'rust-worker', 'csv-judge'] }));
app.post('/api/auth/register', asyncRoute(async (req, res) => {
    const { username, email, password } = req.body || {};
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,40}$/.test(username) || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || email.length > 255 || typeof password !== 'string' || password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Username: 3–40 letters/numbers/_. Valid email and password length 10–128 required.' });
    const hash = await bcrypt.hash(password, 12); const id = randomUUID();
    try { await pool.query('INSERT INTO users(id,username,email,password_hash) VALUES($1,$2,$3,$4)', [id, username, email.toLowerCase(), hash]); }
    catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Username or email already exists' }); throw e }
    res.status(201).json({ token: tokenFor({ id, username, role: 'student' }), user: { id, username, email: email.toLowerCase(), role: 'student', avatar: null } });
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Invalid credentials' });
    const q = await pool.query('SELECT * FROM users WHERE username=$1 OR email=$1 LIMIT 1', [username]); const u = q.rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ token: tokenFor(u), user: { id: u.id, username: u.username, email: u.email, role: u.role, avatar: u.avatar } });
}));
app.get('/api/auth/me', auth, asyncRoute(async (req, res) => res.json({ user: await profileFor(req.user.id) })));
app.get('/api/chat/sessions', auth, team, asyncRoute(async (req, res) => {
    const result = await pool.query(`SELECT id,title,token_limit,tokens_used,generating,created_at,updated_at
        FROM chat_sessions WHERE user_id=$1 ORDER BY updated_at DESC,id DESC`, [req.user.id]);
    res.json({ sessions: result.rows.map(chatSessionPayload), configured: Boolean(geminiApiKey), model: geminiModel });
}));
app.post('/api/chat/sessions', auth, team, asyncRoute(async (req, res) => {
    const result = await pool.query(`INSERT INTO chat_sessions(id,user_id,token_limit) VALUES($1,$2,$3)
        RETURNING id,title,token_limit,tokens_used,generating,created_at,updated_at`, [randomUUID(), req.user.id, chatTokenLimit]);
    res.status(201).json({ session: chatSessionPayload(result.rows[0]) });
}));
app.get('/api/chat/sessions/:id', auth, team, asyncRoute(async (req, res) => {
    const session = await pool.query(`SELECT id,title,token_limit,tokens_used,generating,created_at,updated_at
        FROM chat_sessions WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    if (!session.rowCount) return res.status(404).json({ error: 'Chat session not found' });
    const messages = await pool.query(`SELECT id,role,content,token_count,finish_reason,created_at
        FROM chat_messages WHERE session_id=$1 ORDER BY ordinal`, [req.params.id]);
    res.json({ session: chatSessionPayload(session.rows[0]), messages: messages.rows });
}));
app.post('/api/chat/sessions/:id/messages', auth, team, async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message || message.length > 12000) return res.status(400).json({ error: 'Message must contain 1–12,000 characters' });
    if (!geminiApiKey) return res.status(503).json({ error: 'Chatbot is not configured. Ask an administrator to add GEMINI_API_KEY.' });

    let lockedSession;
    const lockClient = await pool.connect();
    try {
        await lockClient.query('BEGIN');
        const selected = await lockClient.query(`SELECT id,title,token_limit,tokens_used,generating,created_at,updated_at
            FROM chat_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [req.params.id, req.user.id]);
        if (!selected.rowCount) {
            await lockClient.query('ROLLBACK');
            return res.status(404).json({ error: 'Chat session not found' });
        }
        lockedSession = selected.rows[0];
        if (lockedSession.generating) {
            await lockClient.query('ROLLBACK');
            return res.status(409).json({ error: 'This chat is already generating a response' });
        }
        if (Number(lockedSession.tokens_used) >= Number(lockedSession.token_limit)) {
            await lockClient.query('ROLLBACK');
            return res.status(409).json({ error: `This chat has used all ${Number(lockedSession.token_limit).toLocaleString('en-US')} tokens. Create a new chat to continue.` });
        }
        await lockClient.query('UPDATE chat_sessions SET generating=TRUE WHERE id=$1', [lockedSession.id]);
        await lockClient.query('COMMIT');
    } catch (error) {
        await lockClient.query('ROLLBACK').catch(() => {});
        lockClient.release();
        return res.status(500).json({ error: 'Could not lock this chat session' });
    }
    lockClient.release();

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 120000);
    let responseOpen = true;
    let output = '';
    let finishReason = null;
    let usageMetadata = null;
    try {
        const previous = await pool.query(`SELECT role,content FROM chat_messages WHERE session_id=$1 ORDER BY ordinal`, [lockedSession.id]);
        const inputContents = [{ role: 'user', parts: [{ text: message }] }];
        const inputTokens = await countGeminiTokens({
            apiKey: geminiApiKey,
            model: geminiModel,
            contents: inputContents,
            signal: abortController.signal,
        });
        const remaining = Number(lockedSession.token_limit) - Number(lockedSession.tokens_used);
        if (inputTokens >= remaining) {
            await pool.query('UPDATE chat_sessions SET generating=FALSE WHERE id=$1', [lockedSession.id]);
            clearTimeout(timeout);
            return res.status(400).json({ error: `This message needs ${inputTokens} tokens and leaves no room for a reply. ${remaining} tokens remain.` });
        }
        const outputBudget = remaining - inputTokens;
        const contents = previous.rows.map(row => ({ role: row.role, parts: [{ text: row.content }] }));
        contents.push(...inputContents);

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        res.on('close', () => { responseOpen = false; });
        sendChatEvent(res, { type: 'start', input_tokens: inputTokens, output_limit: outputBudget });

        for await (const chunk of streamGeminiResponse({
            apiKey: geminiApiKey,
            model: geminiModel,
            contents,
            maxOutputTokens: outputBudget,
            signal: abortController.signal,
        })) {
            if (chunk.text) {
                output += chunk.text;
                sendChatEvent(res, { type: 'delta', text: chunk.text });
            }
            if (chunk.finishReason) finishReason = chunk.finishReason;
            if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
        }

        let outputTokens = Number(usageMetadata?.candidatesTokenCount);
        if ((!Number.isInteger(outputTokens) || outputTokens < 0) && output) {
            outputTokens = await countGeminiTokens({
                apiKey: geminiApiKey,
                model: geminiModel,
                contents: [{ role: 'model', parts: [{ text: output }] }],
                signal: abortController.signal,
            });
        }
        if (!Number.isInteger(outputTokens) || outputTokens < 0) outputTokens = 0;
        outputTokens = Math.min(outputBudget, outputTokens);
        if (finishReason === 'MAX_TOKENS') outputTokens = outputBudget;

        const saveClient = await pool.connect();
        let savedSession;
        try {
            await saveClient.query('BEGIN');
            const current = await saveClient.query(`SELECT title FROM chat_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [lockedSession.id, req.user.id]);
            if (!current.rowCount) throw new Error('Chat session disappeared while generating');
            await saveClient.query(`INSERT INTO chat_messages(id,session_id,role,content,token_count) VALUES($1,$2,'user',$3,$4)`, [randomUUID(), lockedSession.id, message, inputTokens]);
            if (output) await saveClient.query(`INSERT INTO chat_messages(id,session_id,role,content,token_count,finish_reason) VALUES($1,$2,'model',$3,$4,$5)`, [randomUUID(), lockedSession.id, output, outputTokens, finishReason]);
            const title = current.rows[0].title === 'New chat' ? chatTitle(message) : current.rows[0].title;
            const updated = await saveClient.query(`UPDATE chat_sessions SET title=$2,tokens_used=LEAST(token_limit,tokens_used+$3),generating=FALSE,updated_at=now()
                WHERE id=$1 RETURNING id,title,token_limit,tokens_used,generating,created_at,updated_at`, [lockedSession.id, title, inputTokens + outputTokens]);
            savedSession = chatSessionPayload(updated.rows[0]);
            await saveClient.query('COMMIT');
        } catch (error) {
            await saveClient.query('ROLLBACK').catch(() => {});
            throw error;
        } finally { saveClient.release(); }

        sendChatEvent(res, {
            type: 'done',
            session: savedSession,
            output_tokens: outputTokens,
            finish_reason: finishReason,
            exhausted: savedSession.remaining_tokens === 0,
        });
        if (responseOpen && !res.writableEnded) res.end();
    } catch (error) {
        await pool.query('UPDATE chat_sessions SET generating=FALSE WHERE id=$1', [lockedSession.id]).catch(() => {});
        console.error('Gemini chat generation failed', { session_id: lockedSession.id, model: geminiModel, error: error.message });
        if (res.headersSent) {
            sendChatEvent(res, { type: 'error', error: 'Gemini could not complete this response. Please try again.' });
            if (responseOpen && !res.writableEnded) res.end();
        } else res.status(502).json({ error: 'Gemini could not complete this response. Please try again.' });
    } finally { clearTimeout(timeout); }
});
app.put('/api/auth/profile', auth, asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[a-zA-Z0-9_]{3,40}$/.test(username) || !/^\S+@\S+\.\S+$/.test(email) || email.length > 255) {
        return res.status(400).json({ error: 'Username must be 3–40 letters/numbers/_. Enter a valid email.' });
    }
    try { await pool.query('UPDATE users SET username=$1,email=$2 WHERE id=$3', [username, email, req.user.id]); }
    catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Username or email already exists' }); throw e }
    res.json({ user: await profileFor(req.user.id) });
}));
app.post('/api/auth/avatar', auth, avatarUpload.single('avatar'), asyncRoute(async (req, res) => {
    const file = req.file;
    const png = file?.mimetype === 'image/png' && file.buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    const jpeg = file?.mimetype === 'image/jpeg' && file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff;
    const webp = file?.mimetype === 'image/webp' && file.buffer.subarray(0, 4).toString() === 'RIFF' && file.buffer.subarray(8, 12).toString() === 'WEBP';
    if (!file || (!png && !jpeg && !webp)) return res.status(400).json({ error: 'Upload a valid PNG, JPEG or WebP image' });
    const avatar = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    await pool.query('UPDATE users SET avatar=$1 WHERE id=$2', [avatar, req.user.id]);
    res.json({ avatar });
}));
app.get('/api/users/:username/profile', asyncRoute(async (req, res) => {
    const profile = await publicProfileFor(req.params.username);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({ user: profile });
}));
app.get('/api/problems', asyncRoute(async (_req, res) => {
    const rows = await listProblems();
    res.json({ problems: rows.map(r => ({ ...publicProblem(r.data), submissions: r.submissions, participants: r.participants })) });
}));
app.get('/api/problems/:slug', asyncRoute(async (req, res) => { const p = await findProblem(req.params.slug); if (!p) return res.status(404).json({ error: 'Not found' }); res.json({ problem: publicProblem(p) }) }));
app.get('/api/problems/:slug/data-files', asyncRoute(async (req, res) => {
    const problem = await findProblem(req.params.slug);
    if (!problem || problem.kind !== 'csv') return res.status(404).json({ error: 'CSV problem not found' });
    res.json({ files: await publicDataFiles(problem.slug), max_challenge_size_mb: datasetMaxMb });
}));
app.get('/api/problems/:slug/data/:fileKey', asyncRoute(async (req, res) => {
    const problem = await findProblem(req.params.slug);
    if (!problem || problem.kind !== 'csv') return res.status(404).json({ error: 'CSV problem not found' });
    const file = await locatePublicDataFile(problem.slug, req.params.fileKey);
    if (!file) return res.status(404).json({ error: 'Competition file not found' });
    res.type(file.contentType).download(file.path, `${problem.slug}-${file.filename}`);
}));
// Public samples only: never expose hidden tests or private CSV ground truth.
app.get('/api/problems/:slug/sample-input.txt', asyncRoute(async(req,res) => {
    const p = await findProblem(req.params.slug);
    if (!p || p.kind !== 'code' || !p.tests?.length) return res.status(404).json({error:'Sample not found'});
    const sample = p.tests[0];
    res.type('text/plain').attachment(`${p.slug}-sample-input.txt`).send(sample.args.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('\n')+'\n');
}));
app.get('/api/problems/:slug/sample-submission.csv', asyncRoute(async(req,res) => {
    const p = await findProblem(req.params.slug);
    if (!p || p.kind !== 'csv') return res.status(404).json({error:'Sample not found'});
    const file = await locatePublicDataFile(p.slug, 'sample_submission');
    if (file) return res.type(file.contentType).download(file.path, `${p.slug}-sample-submission.csv`);
    res.status(404).json({error:'Sample not found'});
}));
app.get('/api/contests', optionalAuth, asyncRoute(async (req, res) => {
    await syncExpiredContests();
    const q = await pool.query(`SELECT c.*,
        COUNT(DISTINCT cp.problem_slug)::int AS problem_count,
        COUNT(DISTINCT participants.user_id)::int AS participant_count,
        BOOL_OR(joined.user_id IS NOT NULL) AS joined
        FROM contests c
        LEFT JOIN contest_problems cp ON cp.contest_id=c.id
        LEFT JOIN contest_participants participants ON participants.contest_id=c.id
        LEFT JOIN contest_participants joined ON joined.contest_id=c.id AND joined.user_id=$1
        GROUP BY c.id
        ORDER BY c.created_at DESC`, [req.user?.id || null]);
    res.json({ contests: q.rows.map(contestView) });
}));

app.get('/api/contests/:slug', optionalAuth, asyncRoute(async (req, res) => {
    const contest = await contestForSlug(req.params.slug, req.user?.id || null);
    if (!contest) return res.status(404).json({ error: 'Contest not found' });
    let problems = [];
    if (canReadContestProblems(contest, req.user)) {
        const q = await pool.query(`SELECT cp.label,cp.position,p.data FROM contest_problems cp JOIN problems p ON p.slug=cp.problem_slug
            WHERE cp.contest_id=$1 ORDER BY cp.position`, [contest.id]);
        problems = q.rows.map(row => ({ ...publicProblem(row.data), label: row.label, position: row.position }));
    }
    res.json({ contest: { ...contestView(contest), can_access: canReadContestProblems(contest, req.user), problems } });
}));

app.post('/api/contests/:slug/join', auth, rateLimit({ windowMs: 60000, limit: 10 }), asyncRoute(async (req, res) => {
    const contest = await contestForSlug(req.params.slug, req.user.id);
    if (!contest) return res.status(404).json({ error: 'Contest not found' });
    if (effectiveContestStatus(contest) !== 'open') return res.status(409).json({ error: 'This contest is not currently open' });
    const role = await currentUserRole(req.user.id);
    if (!roleCanEnterContest(contest.type, role) || role === 'admin') return res.status(403).json({ error: contest.type === 'csv' ? 'A team account is required for this contest' : 'A personal student account is required for this contest' });
    if (typeof req.body?.password !== 'string' || !(await bcrypt.compare(req.body.password, contest.password_hash))) return res.status(403).json({ error: 'Incorrect contest password' });
    await pool.query('INSERT INTO contest_participants(contest_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [contest.id, req.user.id]);
    res.json({ ok: true });
}));

async function readableContestProblem(req, res) {
    const contest = await contestForSlug(req.params.slug, req.user?.id || null);
    if (!contest || !canReadContestProblems(contest, req.user)) {
        res.status(403).json({ error: effectiveContestStatus(contest) === 'open' ? 'Join this contest to view its problems' : 'Contest problem is unavailable' });
        return null;
    }
    const attached = await contestProblem(contest.id, req.params.problemSlug);
    if (!attached) { res.status(404).json({ error: 'Contest problem not found' }); return null; }
    return { contest, attached };
}

app.get('/api/contests/:slug/problems/:problemSlug', optionalAuth, asyncRoute(async (req, res) => {
    const context = await readableContestProblem(req, res); if (!context) return;
    res.json({ problem: { ...publicProblem(context.attached.data), label: context.attached.label }, contest: contestView(context.contest) });
}));
app.get('/api/contests/:slug/problems/:problemSlug/data-files', optionalAuth, asyncRoute(async (req, res) => {
    const context = await readableContestProblem(req, res); if (!context) return;
    if (context.attached.data.kind !== 'csv') return res.status(404).json({ error: 'CSV problem not found' });
    res.json({ files: await publicDataFiles(context.attached.data.slug), max_challenge_size_mb: datasetMaxMb });
}));
app.get('/api/contests/:slug/problems/:problemSlug/data/:fileKey', optionalAuth, asyncRoute(async (req, res) => {
    const context = await readableContestProblem(req, res); if (!context) return;
    const file = await locatePublicDataFile(context.attached.data.slug, req.params.fileKey);
    if (!file) return res.status(404).json({ error: 'Competition file not found' });
    res.type(file.contentType).download(file.path, `${context.attached.data.slug}-${file.filename}`);
}));
app.get('/api/contests/:slug/problems/:problemSlug/sample-input.txt', optionalAuth, asyncRoute(async (req, res) => {
    const context = await readableContestProblem(req, res); if (!context) return;
    const problem = context.attached.data;
    if (problem.kind !== 'code' || !problem.tests?.length) return res.status(404).json({ error: 'Sample not found' });
    const sample = problem.tests[0];
    res.type('text/plain').attachment(`${problem.slug}-sample-input.txt`).send(sample.args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n');
}));

app.get('/api/contests/:slug/leaderboard', optionalAuth, asyncRoute(async (req, res) => {
    const contest = await contestForSlug(req.params.slug, req.user?.id || null);
    if (!contest || (effectiveContestStatus(contest) !== 'ended' && !canReadContestProblems(contest, req.user))) return res.status(403).json({ error: 'Contest leaderboard is unavailable' });
    const problemsResult = await pool.query('SELECT problem_slug,label,position FROM contest_problems WHERE contest_id=$1 ORDER BY position', [contest.id]);
    const participantsResult = await pool.query(`SELECT u.id,u.username,u.avatar,cp.joined_at FROM contest_participants cp JOIN users u ON u.id=cp.user_id
        WHERE cp.contest_id=$1 ORDER BY cp.joined_at,u.username`, [contest.id]);
    const submissionsResult = await pool.query(`SELECT s.user_id,s.problem_slug,s.score,s.normalized_score,s.status,s.created_at,s.id,
        CASE WHEN s.kind='csv' THEN s.normalized_score ELSE s.score END AS contest_score
        FROM submissions s WHERE s.contest_id=$1 AND s.status IN ('accepted','failed')
        ORDER BY s.user_id,s.problem_slug,contest_score DESC NULLS LAST,s.created_at ASC,s.id ASC`, [contest.id]);
    const attemptsResult = await pool.query('SELECT user_id,COUNT(*)::int AS attempts FROM submissions WHERE contest_id=$1 GROUP BY user_id', [contest.id]);
    const attempts = new Map(attemptsResult.rows.map(row => [row.user_id, row.attempts]));
    const best = new Map();
    const attemptsByProblem = new Map();
    const firstSolve = new Map();
    for (const row of submissionsResult.rows) {
        const key = `${row.user_id}:${row.problem_slug}`;
        attemptsByProblem.set(key, (attemptsByProblem.get(key) || 0) + 1);
        if (row.contest_score != null && !best.has(key)) best.set(key, row);
        if (row.status === 'accepted' && Number(row.contest_score) >= 99.999) {
            const first = firstSolve.get(row.problem_slug);
            if (!first || new Date(row.created_at) < new Date(first.created_at)) firstSolve.set(row.problem_slug, row);
        }
    }
    const entries = participantsResult.rows.map(participant => {
        const scores = {}; let total = 0; let achievedAt = null;
        for (const problem of problemsResult.rows) {
            const row = best.get(`${participant.id}:${problem.problem_slug}`);
            const score = row ? Number(row.contest_score) : 0;
            const solved = Boolean(row && row.status === 'accepted' && score >= 99.999);
            const elapsedSeconds = solved && contest.start_at ? Math.max(0, Math.floor((new Date(row.created_at) - new Date(contest.start_at)) / 1000)) : null;
            scores[problem.label] = {
                score,
                attempts: attemptsByProblem.get(`${participant.id}:${problem.problem_slug}`) || 0,
                solved,
                solved_at: solved ? row.created_at : null,
                elapsed_seconds: elapsedSeconds,
                first_solve: solved && firstSolve.get(problem.problem_slug)?.user_id === participant.id,
            };
            total += score;
            if (row && (!achievedAt || new Date(row.created_at) > new Date(achievedAt))) achievedAt = row.created_at;
        }
        return { username: participant.username, avatar: participant.avatar, scores, total, attempts: attempts.get(participant.id) || 0, achieved_at: achievedAt };
    }).sort((a, b) => b.total - a.total || (a.achieved_at ? new Date(a.achieved_at) : Infinity) - (b.achieved_at ? new Date(b.achieved_at) : Infinity) || a.attempts - b.attempts || a.username.localeCompare(b.username));
    entries.forEach((entry, index) => { entry.rank = index + 1; });
    res.json({ contest: contestView(contest), problems: problemsResult.rows, entries });
}));
app.get('/api/leaderboard', asyncRoute(async (_req, res) => {
    const q = await pool.query(`WITH first_accept AS (
            SELECT user_id,problem_slug,MIN(created_at) AS accepted_at
            FROM submissions
            WHERE kind='code' AND status='accepted'
            GROUP BY user_id,problem_slug
        ), rank_stats AS (
            SELECT s.user_id,
                COUNT(DISTINCT s.problem_slug) FILTER(WHERE s.status='accepted')::int AS solved,
                COUNT(s.id) FILTER(WHERE fa.accepted_at IS NULL OR s.created_at<=fa.accepted_at)::int AS attempts
            FROM submissions s
            LEFT JOIN first_accept fa ON fa.user_id=s.user_id AND fa.problem_slug=s.problem_slug
            WHERE s.kind='code'
            GROUP BY s.user_id
        )
        SELECT u.username,u.avatar,COALESCE(rs.solved,0)::int AS solved,COALESCE(rs.attempts,0)::int AS attempts
        FROM users u
        LEFT JOIN rank_stats rs ON rs.user_id=u.id
        WHERE u.role='student'
        ORDER BY solved DESC,attempts ASC,u.username
        LIMIT 50`);
    res.json({ users: q.rows });
}));
app.get('/api/submissions', auth, asyncRoute(async (req, res) => {
    const slug = typeof req.query.slug === 'string' ? req.query.slug : null;
    const contestSlug = typeof req.query.contest_slug === 'string' ? req.query.contest_slug : null;
    const fields = `s.id,s.problem_slug,s.kind,s.status,s.passed,s.total,s.normalized_score,
        CASE WHEN s.kind='code' AND s.total>0 THEN s.passed::double precision*100/s.total ELSE s.score END AS score,
        CASE WHEN s.kind='code' THEN 'AC rate' ELSE s.metric END AS metric,s.created_at,
        COALESCE(p.data->>'title',s.problem_slug) AS problem_title,
        COALESCE(p.data->>'category',CASE WHEN s.kind='csv' THEN 'AI Track' ELSE 'Function Only' END) AS problem_category`;
    const q = slug
        ? contestSlug
            ? await pool.query(`SELECT ${fields} FROM submissions s LEFT JOIN problems p ON p.slug=s.problem_slug JOIN contests c ON c.id=s.contest_id WHERE s.user_id=$1 AND s.problem_slug=$2 AND c.slug=$3 ORDER BY s.created_at DESC LIMIT 100`, [req.user.id, slug, contestSlug])
            : await pool.query(`SELECT ${fields} FROM submissions s LEFT JOIN problems p ON p.slug=s.problem_slug WHERE s.user_id=$1 AND s.problem_slug=$2 AND s.contest_id IS NULL ORDER BY s.created_at DESC LIMIT 100`, [req.user.id, slug])
        : await pool.query(`SELECT ${fields} FROM submissions s LEFT JOIN problems p ON p.slug=s.problem_slug WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 100`, [req.user.id]);
    res.json({ submissions: q.rows });
}));
app.get('/api/submissions/:id', auth, asyncRoute(async (req, res) => { const s = await getSubmission(req.params.id, req.user.id); if (!s) return res.status(404).json({ error: 'Not found' }); res.json({ submission: s }) }));
app.get('/api/problems/:slug/solutions', asyncRoute(async (req, res) => {
    const problem = await findProblem(req.params.slug);
    if (!problem) return res.status(404).json({ error: 'Problem not found' });
    const q = await pool.query(`SELECT s.id,s.kind,s.status,s.passed,s.total,s.normalized_score,
        CASE WHEN s.kind='code' AND s.total>0 THEN s.passed::double precision*100/s.total ELSE s.score END AS score,
        CASE WHEN s.kind='code' THEN 'AC rate' ELSE s.metric END AS metric,s.created_at,u.username,u.avatar
        FROM submissions s JOIN users u ON u.id=s.user_id
        WHERE s.problem_slug=$1 AND u.role<>'admin'
        ORDER BY s.created_at DESC LIMIT 100`, [req.params.slug]);
    res.json({ solutions: q.rows });
}));
app.get('/api/problems/:slug/leaderboard', asyncRoute(async (req, res) => {
    const problem = await findProblem(req.params.slug);
    if (!problem || problem.kind !== 'csv') return res.status(404).json({ error: 'CSV problem not found' });
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const direction = problem.config?.greater_is_better ? 'DESC' : 'ASC';
    const q = await pool.query(`WITH attempts AS (
            SELECT user_id,COUNT(*)::int AS attempts
            FROM submissions WHERE problem_slug=$1 GROUP BY user_id
        ), best AS (
            SELECT s.id,s.user_id,s.score,s.normalized_score,s.created_at,u.username,u.avatar,a.attempts,
                ROW_NUMBER() OVER (PARTITION BY s.user_id ORDER BY s.normalized_score DESC NULLS LAST,s.score ${direction},s.created_at ASC,s.id ASC) AS user_rank
            FROM submissions s
            JOIN users u ON u.id=s.user_id
            JOIN attempts a ON a.user_id=s.user_id
            WHERE s.problem_slug=$1 AND s.kind='csv' AND s.status='accepted' AND s.score IS NOT NULL AND u.role<>'admin'
        ), placed AS (
            SELECT id AS best_submission_id,username,avatar,score,normalized_score,attempts,created_at AS achieved_at,
                (ROW_NUMBER() OVER (ORDER BY normalized_score DESC NULLS LAST,score ${direction},created_at ASC,username ASC))::int AS rank,
                COUNT(*) OVER ()::int AS total_participants
            FROM best WHERE user_rank=1
        )
        SELECT * FROM placed ORDER BY rank LIMIT $2 OFFSET $3`, [problem.slug, limit, offset]);
    const totalParticipants = q.rows[0]?.total_participants || 0;
    res.json({
        metric: problem.metric,
        greater_is_better: Boolean(problem.config?.greater_is_better),
        baseline_score: scoreScale(problem)?.baseline ?? null,
        perfect_score: scoreScale(problem)?.perfect ?? null,
        page,
        limit,
        total_participants: totalParticipants,
        entries: q.rows.map(({ total_participants, ...entry }) => entry),
    });
}));
app.post('/api/submissions/code', auth, rateLimit({ windowMs: 60000, limit: 12 }), asyncRoute(async (req, res) => {
    const { slug, code, contest_slug: contestSlug } = req.body || {};
    if (typeof code !== 'string' || !code.trim() || code.length > 50000) return res.status(400).json({ error: 'Invalid code submission' });
    const { problem: p, contestId } = await submissionProblem(req.user, slug, 'code', contestSlug);
    if (queue.length >= MAX_QUEUE) return res.status(503).json({ error: 'Judge queue full' });
    const id = randomUUID(); await pool.query('INSERT INTO submissions(id,user_id,problem_slug,kind,code,total,contest_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, req.user.id, slug, 'code', code, p.tests.length, contestId]);
    enqueue(() => gradeCode(id, p, code)); res.status(202).json({ id, status: 'queued' });
}));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
app.post('/api/submissions/csv', auth, rateLimit({ windowMs: 60000, limit: 12 }), upload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file || !req.file.originalname.toLowerCase().endsWith('.csv')) return res.status(400).json({ error: 'Select a valid CSV problem and .csv file' });
    const { problem: p, contestId } = await submissionProblem(req.user, req.body.slug, 'csv', req.body.contest_slug);
    if (queue.length >= MAX_QUEUE) return res.status(503).json({ error: 'Judge queue full' });
    const id = randomUUID(); await pool.query('INSERT INTO submissions(id,user_id,problem_slug,kind,total,contest_id) VALUES($1,$2,$3,$4,1,$5)', [id, req.user.id, p.slug, 'csv', contestId]);
    enqueue(() => gradeCsv(id, p, req.file.buffer)); res.status(202).json({ id, status: 'queued' });
}));
// Administrator management. The role is always checked against the DB, not only the JWT.
const adminUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, callback) => callback(null, uploadTmp),
        filename: (_req, _file, callback) => callback(null, randomUUID()),
    }),
    limits: { fileSize: datasetMaxBytes, files: 5, fields: 40 },
});
const importUpload = multer({storage: multer.memoryStorage(), limits:{fileSize:2*1024*1024,files:1}});
const adminFileFields = [
    { name: 'ground_truth', maxCount: 1 },
    { name: 'sample_submission', maxCount: 1 },
    { name: 'train_data', maxCount: 1 },
    { name: 'test_data', maxCount: 1 },
    { name: 'data_bundle', maxCount: 1 },
];
async function cleanupUploads(req) {
    const files = Object.values(req.files || {}).flat();
    await Promise.all(files.map(file => file.path ? rm(file.path, { force: true }).catch(() => {}) : null));
}
async function validateUploadedChallengeFile(file, expectedExtension) {
    if (!file) return;
    if (!file.originalname.toLowerCase().endsWith(expectedExtension) || !file.size) throw Error(`Invalid ${expectedExtension} upload`);
    if (expectedExtension === '.zip') {
        const handle = await open(file.path, 'r');
        const signature = Buffer.alloc(4);
        try { await handle.read(signature, 0, 4, 0); }
        finally { await handle.close(); }
        if (!(signature[0] === 0x50 && signature[1] === 0x4b && [0x03, 0x05, 0x07].includes(signature[2]))) throw Error('Invalid ZIP upload');
    }
}

function contestSlugFromTitle(title) {
    return String(title || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'contest';
}

async function uniqueContestSlug(client, title) {
    const base = contestSlugFromTitle(title);
    for (let suffix = 0; suffix < 1000; suffix += 1) {
        const candidate = suffix ? `${base}-${suffix + 1}` : base;
        const exists = await client.query('SELECT 1 FROM contests WHERE slug=$1', [candidate]);
        if (!exists.rowCount) return candidate;
    }
    throw Error('Could not generate a unique contest URL');
}

function contestFields(body, forcedSlug = '') {
    const slug = String(forcedSlug || body?.slug || '').trim();
    const title = String(body?.title || '').trim();
    const type = String(body?.type || 'code');
    const durationMinutes = Number.parseInt(body?.duration_minutes, 10);
    const password = String(body?.password || '');
    const problemSlugs = Array.isArray(body?.problem_slugs) ? [...new Set(body.problem_slugs.map(value => String(value)))] : [];
    if (slug && (!validatePathSlug(slug) || slug.length > 80)) throw Error('Invalid contest URL');
    if (!title || title.length > 160) throw Error('Contest title is required (maximum 160 characters)');
    if (!['code', 'csv'].includes(type)) throw Error('Contest type must be Function Code or AI Tracks');
    if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 10080) throw Error('Duration must be between 5 and 10080 minutes');
    if (password && (password.length < 4 || password.length > 128)) throw Error('Contest password must be 4–128 characters');
    return { slug, title, type, durationMinutes, password, problemSlugs };
}

async function replaceContestProblems(client, contestId, type, problemSlugs) {
    if (problemSlugs.length) {
        const available = await client.query('SELECT slug,data FROM problems WHERE slug=ANY($1::varchar[])', [problemSlugs]);
        if (available.rowCount !== problemSlugs.length) throw Error('One or more selected problems do not exist');
        if (available.rows.some(row => row.data.kind !== type)) throw Error('Every problem must match the contest type');
        const conflict = await client.query(`SELECT cp.problem_slug FROM contest_problems cp JOIN contests c ON c.id=cp.contest_id
            WHERE cp.problem_slug=ANY($1::varchar[]) AND cp.contest_id<>$2 AND (c.status='closed' OR (c.status='open' AND c.end_at>now())) LIMIT 1`, [problemSlugs, contestId]);
        if (conflict.rowCount) throw Error(`${conflict.rows[0].problem_slug} already belongs to another unfinished contest`);
    }
    await client.query('DELETE FROM contest_problems WHERE contest_id=$1', [contestId]);
    for (const [index, problemSlug] of problemSlugs.entries()) {
        await client.query('INSERT INTO contest_problems(contest_id,problem_slug,position,label) VALUES($1,$2,$3,$4)', [contestId, problemSlug, index, contestProblemLabel(index)]);
        await client.query('UPDATE problems SET active=true,updated_at=now() WHERE slug=$1', [problemSlug]);
    }
}

app.get('/api/admin/team-accounts', auth, admin, asyncRoute(async (_req, res) => {
    const q = await pool.query("SELECT id,username,email,created_at FROM users WHERE role='team' ORDER BY created_at DESC");
    res.json({ accounts: q.rows });
}));
app.post('/api/admin/team-accounts', auth, admin, rateLimit({ windowMs: 60000, limit: 20 }), asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!/^[a-zA-Z0-9_]{3,40}$/.test(username) || password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Username must be 3–40 letters/numbers/_. Password length must be 10–128.' });
    const id = randomUUID();
    try { await pool.query('INSERT INTO users(id,username,email,password_hash,role) VALUES($1,$2,$3,$4,$5)', [id, username, `${username.toLowerCase()}@teams.local.invalid`, await bcrypt.hash(password, 12), 'team']); }
    catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'Team username already exists' }); throw error; }
    res.status(201).json({ account: { id, username, role: 'team' } });
}));

app.get('/api/admin/contests', auth, admin, asyncRoute(async (_req, res) => {
    await syncExpiredContests();
    const contests = await pool.query(`SELECT c.*,COUNT(DISTINCT cp.problem_slug)::int AS problem_count,COUNT(DISTINCT participants.user_id)::int AS participant_count,
        COUNT(DISTINCT submissions.id)::int AS submission_count,false AS joined
        FROM contests c LEFT JOIN contest_problems cp ON cp.contest_id=c.id LEFT JOIN contest_participants participants ON participants.contest_id=c.id
        LEFT JOIN submissions ON submissions.contest_id=c.id
        GROUP BY c.id ORDER BY c.created_at DESC`);
    const assignments = await pool.query('SELECT contest_id,problem_slug,label,position FROM contest_problems ORDER BY contest_id,position');
    const byContest = new Map();
    for (const row of assignments.rows) { if (!byContest.has(row.contest_id)) byContest.set(row.contest_id, []); byContest.get(row.contest_id).push(row); }
    res.json({ contests: contests.rows.map(row => ({ ...contestView(row), problems: byContest.get(row.id) || [] })) });
}));

app.post('/api/admin/contests', auth, admin, asyncRoute(async (req, res) => {
    let fields; try { fields = contestFields(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
    if (!fields.password) return res.status(400).json({ error: 'Contest password is required' });
    const id = randomUUID(); const client = await pool.connect();
    try {
        await client.query('BEGIN');
        fields.slug = await uniqueContestSlug(client, fields.title);
        await client.query(`INSERT INTO contests(id,slug,title,description,type,password_hash,duration_minutes)
            VALUES($1,$2,$3,'',$4,$5,$6)`, [id, fields.slug, fields.title, fields.type, await bcrypt.hash(fields.password, 12), fields.durationMinutes]);
        await replaceContestProblems(client, id, fields.type, fields.problemSlugs);
        await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); if (error.code === '23505') return res.status(409).json({ error: 'Contest slug already exists' }); return res.status(400).json({ error: error.message }); }
    finally { client.release(); }
    res.status(201).json({ id, slug: fields.slug });
}));

app.put('/api/admin/contests/:slug', auth, admin, asyncRoute(async (req, res) => {
    let fields; try { fields = contestFields(req.body, req.params.slug); } catch (error) { return res.status(400).json({ error: error.message }); }
    const existing = await pool.query('SELECT * FROM contests WHERE slug=$1', [req.params.slug]);
    if (!existing.rowCount) return res.status(404).json({ error: 'Contest not found' });
    if (effectiveContestStatus(existing.rows[0]) !== 'closed') return res.status(409).json({ error: 'Only closed contests can be edited' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const passwordHash = fields.password ? await bcrypt.hash(fields.password, 12) : existing.rows[0].password_hash;
        await client.query(`UPDATE contests SET title=$2,type=$3,password_hash=$4,duration_minutes=$5,updated_at=now() WHERE slug=$1`, [fields.slug, fields.title, fields.type, passwordHash, fields.durationMinutes]);
        await replaceContestProblems(client, existing.rows[0].id, fields.type, fields.problemSlugs);
        await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); return res.status(400).json({ error: error.message }); }
    finally { client.release(); }
    res.json({ ok: true });
}));

app.delete('/api/admin/contests/:slug', auth, admin, asyncRoute(async (req, res) => {
    const slug = req.params.slug;
    if (!validatePathSlug(slug) || req.body?.confirm_slug !== slug) return res.status(400).json({ error: 'Type the exact contest slug to confirm permanent deletion' });
    await syncExpiredContests();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const contest = await client.query('SELECT id,title,status FROM contests WHERE slug=$1 FOR UPDATE', [slug]);
        if (!contest.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Contest not found' });
        }
        if (contest.rows[0].status === 'open') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'End the contest before deleting it' });
        }
        const [problems, participants, submissions] = await Promise.all([
            client.query('SELECT COUNT(*)::int AS count FROM contest_problems WHERE contest_id=$1', [contest.rows[0].id]),
            client.query('SELECT COUNT(*)::int AS count FROM contest_participants WHERE contest_id=$1', [contest.rows[0].id]),
            client.query('SELECT COUNT(*)::int AS count FROM submissions WHERE contest_id=$1', [contest.rows[0].id]),
        ]);
        await client.query('DELETE FROM contests WHERE id=$1', [contest.rows[0].id]);
        await client.query('COMMIT');
        const result = {
            ok: true,
            retained_problems: problems.rows[0].count,
            removed_participants: participants.rows[0].count,
            retained_submissions: submissions.rows[0].count,
        };
        console.info('admin permanent contest deletion', { admin_id: req.user.id, slug, title: contest.rows[0].title, ...result, at: new Date().toISOString() });
        res.json(result);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
}));

app.post('/api/admin/contests/:slug/open', auth, admin, asyncRoute(async (req, res) => {
    const contest = await pool.query(`SELECT c.*,COUNT(cp.problem_slug)::int AS problem_count FROM contests c LEFT JOIN contest_problems cp ON cp.contest_id=c.id
        WHERE c.slug=$1 GROUP BY c.id`, [req.params.slug]);
    if (!contest.rowCount) return res.status(404).json({ error: 'Contest not found' });
    if (contest.rows[0].status !== 'closed') return res.status(409).json({ error: 'Only a closed contest can be opened' });
    if (!contest.rows[0].problem_count) return res.status(409).json({ error: 'Add at least one problem before opening the contest' });
    const q = await pool.query(`UPDATE contests SET status='open',start_at=now(),end_at=now()+(duration_minutes*interval '1 minute'),updated_at=now()
        WHERE slug=$1 RETURNING start_at,end_at`, [req.params.slug]);
    res.json({ ok: true, ...q.rows[0] });
}));

app.post('/api/admin/contests/:slug/end', auth, admin, asyncRoute(async (req, res) => {
    const q = await pool.query("UPDATE contests SET status='ended',end_at=LEAST(COALESCE(end_at,now()),now()),updated_at=now() WHERE slug=$1 AND status='open' RETURNING id", [req.params.slug]);
    if (!q.rowCount) return res.status(409).json({ error: 'Contest is not open' });
    res.json({ ok: true });
}));
async function atomicCopy(sourcePath, dir, filename) {
    const temporary = path.join(dir, `.${filename}.${randomUUID()}.tmp`);
    await copyFile(sourcePath, temporary);
    await chmod(temporary, 0o644);
    await rename(temporary, path.join(dir, filename));
}
async function atomicWrite(buffer, dir, filename) {
    const temporary = path.join(dir, `.${filename}.${randomUUID()}.tmp`);
    await writeFile(temporary, buffer, { mode: 0o644 });
    await rename(temporary, path.join(dir, filename));
}
async function ensureChallengeCapacity(slug, uploads, removals) {
    const summary = await challengeFileSummary(slug);
    const existing = new Map(summary.files.map(file => [file.name, file.size]));
    let projected = summary.bytes;
    for (const filename of removals) projected -= existing.get(filename) || 0;
    for (const [filename, file] of uploads) projected += file.size - (existing.get(filename) || 0);
    if (projected > datasetMaxBytes) throw Error(`Challenge files exceed the ${datasetMaxMb} MB limit`);
    const disk = await statfs(csvRoot);
    const incomingBytes = [...uploads.values()].reduce((total, file) => total + file.size, 0);
    if (incomingBytes > Number(disk.bavail) * Number(disk.bsize)) throw Error('Not enough disk space for challenge files');
}
app.get('/api/admin/problems/import-template.csv', auth, admin, (_req,res) => {
    const template = 'slug,title,category,difficulty,description,function,class_name,starter,input,output\n' +
      'add-two,Add Two Numbers,Python,Easy,Return the sum of two integers.,add,,"def add(a, b):\n    pass","2\n5",7\n';
    res.type('text/csv').attachment('python-problems-template.csv').send(template);
});
app.post('/api/admin/problems/import-csv', auth, admin, rateLimit({windowMs:60000,limit:5}), importUpload.single('file'), asyncRoute(async(req,res) => {
    if (!req.file?.originalname?.toLowerCase().endsWith('.csv')) return res.status(400).json({error:'Upload a CSV file'});
    let rows;
    try { rows = parseCsv(req.file.buffer.toString('utf8'), {columns:true,skip_empty_lines:true,bom:true}); }
    catch(e) { return res.status(400).json({error:'Invalid CSV: '+e.message}); }
    if (!rows.length || rows.length>1000) return res.status(400).json({error:'Expected 1-1000 rows'});
    const required=['slug','title','description','function','input','output'];
    if(required.some(k=>!Object.hasOwn(rows[0],k))) return res.status(400).json({error:`Required headers: ${required.join(', ')}`});
    const groups=new Map();
    try {
        for(const row of rows) {
            const slug=(row.slug||'').trim();
            if(!groups.has(slug)) groups.set(slug,{...row,slug,tests:[]});
            const group=groups.get(slug);
            for(const k of ['title','description','function','class_name','starter','category','difficulty']) {
                if ((group[k]||'') !== (row[k]||'')) throw Error(`Conflicting ${k} for ${slug}`);
            }
            group.tests.push(testFromText(row.input,row.output));
        }
        if(groups.size>100) throw Error('Maximum 100 problems per import');
        const problems=[...groups.values()].map(row=>problemFields({...row,kind:'code',tests:JSON.stringify(row.tests)}));
        const targetContestSlug=String(req.body?.contest_slug || '').trim();
        const client=await pool.connect();
        try {
            await client.query('BEGIN');
            let targetContest=null;
            let nextPosition=0;
            if(targetContestSlug) {
                const contest=await client.query("SELECT id,type,status FROM contests WHERE slug=$1 FOR UPDATE",[targetContestSlug]);
                if(!contest.rowCount) throw Error('Target contest not found');
                targetContest=contest.rows[0];
                if(targetContest.status!=='closed') throw Error('Private exercises can only be imported into a closed contest');
                if(targetContest.type!=='code') throw Error('Bulk Python import is only available for Function Code contests');
                const position=await client.query('SELECT COALESCE(MAX(position),-1)+1 AS next_position FROM contest_problems WHERE contest_id=$1',[targetContest.id]);
                nextPosition=Number(position.rows[0].next_position);
            }
            for(const problem of problems) {
                await client.query('INSERT INTO problems(slug,data) VALUES($1,$2::jsonb)',[problem.slug,JSON.stringify(problem)]);
                if(targetContest) {
                    await client.query('INSERT INTO contest_problems(contest_id,problem_slug,position,label) VALUES($1,$2,$3,$4)',[targetContest.id,problem.slug,nextPosition,contestProblemLabel(nextPosition)]);
                    nextPosition+=1;
                }
            }
            await client.query('COMMIT');
        } catch(e) { await client.query('ROLLBACK'); if(e.code==='23505') throw Error('A slug already exists; import canceled'); throw e }
        finally { client.release(); }
        res.status(201).json({imported:problems.length,tests:rows.length});
    }catch(e) { res.status(400).json({error:String(e.message).slice(0,240)}); }
}));
app.get('/api/admin/problems', auth, admin, asyncRoute(async (_req, res) => {
    const rows = await pool.query(`SELECT p.slug,p.active,p.data,p.created_at,p.updated_at,COUNT(s.id)::int AS submission_count
        FROM problems p LEFT JOIN submissions s ON s.problem_slug=p.slug
        GROUP BY p.slug,p.active,p.data,p.created_at,p.updated_at ORDER BY p.created_at DESC`);
    const problems = await Promise.all(rows.rows.map(async r => {
        const summary = r.data.kind === 'csv' ? await challengeFileSummary(r.slug) : { files: [], bytes: 0 };
        return {
            ...r.data,
            active: r.active,
            created_at: r.created_at,
            updated_at: r.updated_at,
            data_files: summary.files.filter(file => file.public),
            deletion_preview: { submissions: r.submission_count, files: summary.files.length, bytes: summary.bytes },
        };
    }));
    res.json({ problems, dataset_max_mb: datasetMaxMb });
}));
app.get('/api/admin/problems/:slug', auth, admin, asyncRoute(async (req, res) => {
    const q = await pool.query('SELECT data,active FROM problems WHERE slug=$1', [req.params.slug]);
    if (!q.rowCount) return res.status(404).json({ error: 'Not found' }); res.json({ problem: { ...q.rows[0].data, active: q.rows[0].active } });
}));
async function saveProblem(req, res, editing = false) {
    try {
        let data;
        try { data = problemFields(req.body); }
        catch (error) { return res.status(400).json({ error: error.message }); }
        if (editing && data.slug !== req.params.slug) return res.status(400).json({ error: 'Slug cannot be changed' });
        const existing = await pool.query('SELECT data,active FROM problems WHERE slug=$1', [data.slug]);
        if (!editing && existing.rowCount) return res.status(409).json({ error: 'Slug already exists' });
        if (editing && (!existing.rowCount || existing.rows[0].data.kind !== data.kind)) return res.status(400).json({ error: 'Problem not found or kind cannot be changed' });
        const targetContestSlug = !editing ? String(req.body?.contest_slug || '').trim() : '';
        let targetContest = null;
        if (targetContestSlug) {
            const contest = await pool.query("SELECT id,slug,title,type,status FROM contests WHERE slug=$1", [targetContestSlug]);
            if (!contest.rowCount) return res.status(404).json({ error: 'Target contest not found' });
            targetContest = contest.rows[0];
            if (targetContest.status !== 'closed') return res.status(409).json({ error: 'Private exercises can only be added to a closed contest' });
            if (targetContest.type !== data.kind) return res.status(400).json({ error: 'Exercise type must match the contest type' });
        }
        if (data.kind === 'csv') {
            const truth = req.files?.ground_truth?.[0];
            const sample = req.files?.sample_submission?.[0];
            const train = req.files?.train_data?.[0];
            const test = req.files?.test_data?.[0];
            const bundle = req.files?.data_bundle?.[0];
            const dir = challengeDir(csvRoot, data.slug);
            const hasDynamicTruth = existsSync(path.join(dir, 'ground_truth.csv'));
            if (editing && !truth && !hasDynamicTruth) return res.status(400).json({ error: 'Upload ground truth CSV when editing a bundled CSV problem' });
            if (!editing && !truth) return res.status(400).json({ error: 'Ground truth CSV required' });
            try {
                await validateUploadedChallengeFile(truth, '.csv');
                await validateUploadedChallengeFile(sample, '.csv');
                await validateUploadedChallengeFile(train, '.csv');
                await validateUploadedChallengeFile(test, '.csv');
                await validateUploadedChallengeFile(bundle, '.zip');
            } catch (error) {
                return res.status(400).json({ error: error.message });
            }
            const uploads = new Map([
                ['ground_truth.csv', truth],
                ['sample_submission.csv', sample],
                ['train.csv', train],
                ['test.csv', test],
                ['data.zip', bundle],
            ].filter(([, file]) => file));
            const removals = new Set();
            for (const [key, definition] of Object.entries(PUBLIC_DATA_FILES)) {
                if (String(req.body[`remove_${key}`] || '') === 'true') {
                    if (uploads.has(definition.filename)) return res.status(400).json({ error: `Cannot upload and remove ${definition.filename} together` });
                    removals.add(definition.filename);
                }
            }
            try { await ensureChallengeCapacity(data.slug, uploads, removals); }
            catch (error) { return res.status(error.message.startsWith('Challenge files exceed') ? 413 : 400).json({ error: error.message }); }
            await mkdir(dir, { recursive: true, mode: 0o755 });
            await chmod(dir, 0o755);
            await atomicWrite(Buffer.from(JSON.stringify(data.config)), dir, 'config.json');
            for (const [filename, file] of uploads) await atomicCopy(file.path, dir, filename);
            for (const filename of removals) await rm(path.join(dir, filename), { force: true });
            // Full configuration and ground truth remain private and are never served by public data routes.
        }
        if (editing) {
            const r = await pool.query('UPDATE problems SET data=$2::jsonb,updated_at=now() WHERE slug=$1 RETURNING slug,active', [data.slug, JSON.stringify(data)]);
            if (!r.rowCount) return res.status(404).json({ error: 'Problem not found' });
        } else {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('INSERT INTO problems(slug,data) VALUES($1,$2::jsonb)', [data.slug, JSON.stringify(data)]);
                if (targetContest) {
                    const position = await client.query('SELECT COALESCE(MAX(position),-1)+1 AS next_position FROM contest_problems WHERE contest_id=$1', [targetContest.id]);
                    const nextPosition = Number(position.rows[0].next_position);
                    await client.query('INSERT INTO contest_problems(contest_id,problem_slug,position,label) VALUES($1,$2,$3,$4)', [targetContest.id, data.slug, nextPosition, contestProblemLabel(nextPosition)]);
                }
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                if (error.code === '23505') return res.status(409).json({ error: 'Slug already exists' });
                throw error;
            } finally { client.release(); }
        }
        if (data.kind === 'csv') await refreshNormalizedScores(data);
        res.status(editing ? 200 : 201).json({ problem: publicProblem(data), contest: targetContest ? { slug: targetContest.slug, title: targetContest.title } : null, data_files: data.kind === 'csv' ? await publicDataFiles(data.slug) : [] });
    } finally {
        await cleanupUploads(req);
    }
}
app.post('/api/admin/problems', auth, admin, rateLimit({ windowMs: 60000, limit: 20 }), adminUpload.fields(adminFileFields), asyncRoute(async (req, res) => saveProblem(req, res)));
app.put('/api/admin/problems/:slug', auth, admin, rateLimit({ windowMs: 60000, limit: 20 }), adminUpload.fields(adminFileFields), asyncRoute(async (req, res) => saveProblem(req, res, true)));
app.delete('/api/admin/problems/:slug', auth, admin, asyncRoute(async (req, res) => {
    const q = await pool.query('UPDATE problems SET active=false,updated_at=now() WHERE slug=$1 AND active=true RETURNING slug', [req.params.slug]);
    if (!q.rowCount) return res.status(409).json({ error: 'Problem not found or already archived' });
    res.json({ ok: true, active: false });
}));
app.post('/api/admin/problems/:slug/unarchive', auth, admin, asyncRoute(async (req, res) => {
    const q = await pool.query('UPDATE problems SET active=true,updated_at=now() WHERE slug=$1 AND active=false RETURNING slug', [req.params.slug]);
    if (!q.rowCount) return res.status(409).json({ error: 'Problem not found or already active' });
    res.json({ ok: true, active: true });
}));
app.delete('/api/admin/problems/:slug/permanent', auth, admin, asyncRoute(async (req, res) => {
    const slug = req.params.slug;
    if (!validatePathSlug(slug) || req.body?.confirm_slug !== slug) return res.status(400).json({ error: 'Type the exact slug to confirm permanent deletion' });
    const problem = await pool.query('SELECT data,active FROM problems WHERE slug=$1', [slug]);
    if (!problem.rowCount) return res.status(404).json({ error: 'Problem not found' });
    if (problem.rows[0].active) return res.status(409).json({ error: 'Archive the problem before deleting it permanently' });
    const dir = challengeDir(csvRoot, slug);
    const trash = path.join(path.resolve(csvRoot), `.trash-${slug}-${randomUUID()}`);
    let moved = false;
    if (problem.rows[0].data.kind === 'csv' && existsSync(dir)) { await rename(dir, trash); moved = true; }
    const client = await pool.connect();
    let submissionCount = 0;
    try {
        await client.query('BEGIN');
        const submissions = await client.query('DELETE FROM submissions WHERE problem_slug=$1', [slug]);
        submissionCount = submissions.rowCount;
        const deleted = await client.query('DELETE FROM problems WHERE slug=$1 AND active=false', [slug]);
        if (!deleted.rowCount) throw Error('Problem state changed before deletion');
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        if (moved) await rename(trash, dir).catch(restoreError => console.error('problem file restore failed', restoreError));
        throw error;
    } finally { client.release(); }
    let cleanupPending = false;
    if (moved) {
        try { await rm(trash, { recursive: true, force: true }); }
        catch (error) { cleanupPending = true; console.error('problem file cleanup pending', { slug, trash, error }); }
    }
    console.info('admin permanent problem deletion', { admin_id: req.user.id, slug, submissions: submissionCount, files_removed: moved, cleanup_pending: cleanupPending, at: new Date().toISOString() });
    res.json({ ok: true, deleted_submissions: submissionCount, files_removed: moved, cleanup_pending: cleanupPending });
}));
app.delete('/api/admin/contests/:slug/problems/:problemSlug', auth, admin, asyncRoute(async (req, res) => {
    const { slug: contestSlug, problemSlug } = req.params;
    if (!validatePathSlug(contestSlug) || !validatePathSlug(problemSlug) || req.body?.confirm_slug !== problemSlug) return res.status(400).json({ error: 'Invalid deletion confirmation' });
    const attached = await pool.query(`SELECT c.id AS contest_id,c.status,p.data FROM contests c
        JOIN contest_problems cp ON cp.contest_id=c.id JOIN problems p ON p.slug=cp.problem_slug
        WHERE c.slug=$1 AND cp.problem_slug=$2`, [contestSlug, problemSlug]);
    if (!attached.rowCount) return res.status(404).json({ error: 'Contest exercise not found' });
    if (attached.rows[0].status !== 'closed') return res.status(409).json({ error: 'Exercises can only be deleted while the contest is closed' });
    const shared = await pool.query('SELECT 1 FROM contest_problems WHERE problem_slug=$1 AND contest_id<>$2 LIMIT 1', [problemSlug, attached.rows[0].contest_id]);
    if (shared.rowCount) return res.status(409).json({ error: 'This exercise is also used by another contest and cannot be deleted here' });
    const dir = challengeDir(csvRoot, problemSlug);
    const trash = path.join(path.resolve(csvRoot), `.trash-${problemSlug}-${randomUUID()}`);
    let moved = false;
    if (attached.rows[0].data.kind === 'csv' && existsSync(dir)) { await rename(dir, trash); moved = true; }
    const client = await pool.connect();
    let submissionCount = 0;
    try {
        await client.query('BEGIN');
        const submissions = await client.query('DELETE FROM submissions WHERE problem_slug=$1', [problemSlug]);
        submissionCount = submissions.rowCount;
        await client.query('DELETE FROM contest_problems WHERE contest_id=$1 AND problem_slug=$2', [attached.rows[0].contest_id, problemSlug]);
        await client.query('DELETE FROM problems WHERE slug=$1', [problemSlug]);
        const remaining = await client.query('SELECT problem_slug FROM contest_problems WHERE contest_id=$1 ORDER BY position', [attached.rows[0].contest_id]);
        for (const [index, row] of remaining.rows.entries()) await client.query('UPDATE contest_problems SET position=$3,label=$4 WHERE contest_id=$1 AND problem_slug=$2', [attached.rows[0].contest_id, row.problem_slug, index, contestProblemLabel(index)]);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        if (moved) await rename(trash, dir).catch(restoreError => console.error('contest problem file restore failed', restoreError));
        throw error;
    } finally { client.release(); }
    let cleanupPending = false;
    if (moved) {
        try { await rm(trash, { recursive: true, force: true }); }
        catch (error) { cleanupPending = true; console.error('contest problem file cleanup pending', { problemSlug, trash, error }); }
    }
    res.json({ ok: true, deleted_submissions: submissionCount, files_removed: moved, cleanup_pending: cleanupPending });
}));
app.use(async (err, req, res, _next) => {
    await cleanupUploads(req);
    console.error(err);
    const uploadLimit = ['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(err.code);
    const status = uploadLimit ? 413 : Number(err.statusCode) || 500;
    res.status(status).json({ error: uploadLimit ? `Upload exceeds the ${datasetMaxMb} MB challenge limit or allowed file count` : status < 500 ? err.message : 'Request failed' });
});
await initialize(); server.listen(Number(process.env.PORT || 4000), '0.0.0.0', () => console.log('Platform API listening'));
