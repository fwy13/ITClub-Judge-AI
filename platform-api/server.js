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
// Only send the callable signature; never expose a stored reference implementation.
// Leave `pass` as a placeholder so the code remains a valid Python submission.
function publicSignature(p) {
    if (p.kind !== 'code') return '';
    const source = String(p.starter || '');
    const escaped = String(p.function || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('^\\s*(?:async\\s+)?def\\s+' + escaped + '\\s*\\([^\\n]*\\)\\s*(?:->[^:\\n]+)?\\s*:', 'm');
    const match = source.match(pattern);
    const declaration = match ? match[0].trim() : `def ${p.function || 'solve'}(*args, **kwargs):`;
    if (p.class_name) return `class ${p.class_name}:\n    ${declaration}\n        pass`;
    return `${declaration}\n    pass`;
}
const publicProblem = p => ({
    slug: p.slug,
    title: p.title,
    category: p.category,
    difficulty: p.difficulty,
    kind: p.kind,
    description: p.description,
    starter: publicSignature(p),
    metric: p.metric,
    greater_is_better: p.kind === 'csv' ? Boolean(p.config?.greater_is_better) : null,
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
async function admin(req, res, next) {
    try { const q = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]); if (q.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' }); next() } catch (e) { next(e) }
}
function send(socket, payload) { if (socket.readyState === 1) socket.send(JSON.stringify(payload)) }
function broadcast(id, event) { for (const ws of sockets.get(id) || []) send(ws, event) }
function subscribe(ws, id) { let s = sockets.get(id); if (!s) { s = new Set(); sockets.set(id, s) } s.add(ws); ws._subscriptions.add(id) }
async function getSubmission(id, uid) {
    const q = await pool.query(`SELECT id,problem_slug,kind,status,passed,total,
        CASE WHEN kind='code' AND total>0 THEN passed::double precision*100/total ELSE score END AS score,
        CASE WHEN kind='code' THEN 'AC rate' ELSE metric END AS metric,results,error,created_at
        FROM submissions WHERE id=$1 AND user_id=$2`, [id, uid]);
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
            const response = await axios.post(workerUrl + '/internal/execute', { code, function: problem.function, class_name: problem.class_name, tests: [tests[i]], time_limit_ms: 12000, memory_limit_mb: 2048 }, { timeout: 30000 });
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
async function gradeCsv(id, slug, buffer) {
    try {
        const { data } = await axios.post(csvUrl + '/grade/' + encodeURIComponent(slug), buffer, { headers: { 'Content-Type': 'text/csv', 'X-Internal-Key': process.env.CSV_INTERNAL_KEY }, timeout: 120000, maxBodyLength: 12 * 1024 * 1024 });
        await update(id, { status: data.status === 'accepted' ? 'accepted' : 'failed', score: data.score ?? null, metric: data.metric ?? null, error: data.message ?? null, results: JSON.stringify([data]), passed: data.status === 'accepted' ? 1 : 0, total: 1 }, 'completed');
    } catch (e) { await update(id, { status: 'failed', error: String(e.response?.data?.detail || e.message).slice(0, 500) }, 'completed') }
}
const seededProblems = JSON.parse(await readFile(new URL('./problems.json', import.meta.url), 'utf8'));
async function listProblems() {
    const q = await pool.query(`SELECT p.data,COUNT(s.id)::int AS submissions,COUNT(DISTINCT s.user_id)::int AS participants
        FROM problems p LEFT JOIN submissions s ON s.problem_slug=p.slug
        WHERE p.active=true GROUP BY p.slug,p.data,p.created_at ORDER BY p.created_at DESC,p.slug DESC`);
    return q.rows;
}
async function findProblem(slug) { const q = await pool.query('SELECT data FROM problems WHERE slug=$1 AND active=true', [slug]); return q.rows[0]?.data || null }
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
const csvMetrics = { binary_probability: ['log_loss', 'accuracy', 'f1', 'precision', 'recall', 'balanced_accuracy'], multiclass_probability: ['log_loss', 'accuracy', 'macro_f1', 'macro_precision', 'macro_recall'], multilabel_probability: ['micro_f1', 'macro_f1', 'hamming_loss'], regression: ['rmse', 'mae', 'mse', 'r2', 'mape', 'smape'], ranking: ['ndcg_at_k', 'mrr', 'map', 'recall_at_k'], text_generation: ['sacrebleu', 'chrf'] };
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
    const slug = String(body.slug || ''), title = String(body.title || ''), description = String(body.description || ''), kind = body.kind;
    if (!validateSlug(slug) || !validText(title, 160) || !validText(description, 12000) || !['code', 'csv'].includes(kind)) throw Error('Invalid slug, title, description or type');
    const difficulty = ['Easy', 'Medium', 'Hard'].includes(body.difficulty) ? body.difficulty : 'Medium';
    const base = { slug, title, description, kind, difficulty, category: String(body.category || 'General').slice(0, 80) };
    if (kind === 'code') {
        const rawTests = parseJson(body.tests); const tests = Array.isArray(rawTests) ? rawTests.map(t => t && typeof t.input === 'string' ? testFromText(t.input, t.output) : t) : null; if (!Array.isArray(tests) || tests.length < 1 || tests.length > 100 || !tests.every(t => t && Array.isArray(t.args) && Object.hasOwn(t, 'expected'))) throw Error('Tests must be an array (1–100) of {args, expected}');
        if (JSON.stringify(tests).length > 100000) throw Error('Test cases exceed 100 KB');
        if (!validText(body.function, 100) || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(body.function)) throw Error('Invalid function name');
        if (body.class_name && !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(body.class_name)) throw Error('Invalid class name');
        return { ...base, starter: String(body.starter || '').slice(0, 20000), function: body.function, class_name: body.class_name || null, tests };
    }
    const config = parseJson(body.config); if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('CSV configuration must be JSON');
    if (!csvMetrics[config.task_type]?.includes(config.metric)) throw Error('Unsupported task_type or metric');
    if (!validText(config.id_column, 100) || !Array.isArray(config.prediction_columns) || !config.prediction_columns.length || !config.prediction_columns.every(x => validText(x, 100))) throw Error('Invalid CSV column configuration');
    if (config.task_type === 'ranking' && !validText(config.item_column, 100)) throw Error('Ranking needs item_column');
    if (!validText(config.target_column, 100)) throw Error('target_column is required');
    return { ...base, starter: '', tests: [], metric: config.metric, config: { ...config, version: 1, max_file_size_mb: 10, max_rows: Math.min(100000, Math.max(1, Number(config.max_rows) || 100000)) } };
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
    const adminUsername = process.env.ADMIN_BOOTSTRAP_USERNAME; const adminPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (adminUsername && adminPassword) {
        if (!/^[a-zA-Z0-9_]{3,40}$/.test(adminUsername) || adminPassword.length < 16) throw Error('Invalid admin bootstrap settings');
        const r = await pool.query('SELECT role FROM users WHERE username=$1', [adminUsername]);
        if (!r.rowCount) { await pool.query('INSERT INTO users(id,username,email,password_hash,role) VALUES($1,$2,$3,$4,$5)', [randomUUID(), adminUsername, `${adminUsername.toLowerCase()}@local.invalid`, await bcrypt.hash(adminPassword, 12), 'admin']); console.log('Administrator account created'); }
        else if (r.rows[0].role !== 'admin') throw Error('ADMIN_BOOTSTRAP_USERNAME conflicts with a non-admin account');
    }

    await pool.query(`CREATE TABLE IF NOT EXISTS submissions(id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id),problem_slug VARCHAR(100) NOT NULL,kind VARCHAR(10) NOT NULL,status VARCHAR(30) NOT NULL DEFAULT 'queued',code TEXT,passed INT NOT NULL DEFAULT 0,total INT NOT NULL DEFAULT 0,score DOUBLE PRECISION,metric VARCHAR(100),results JSONB NOT NULL DEFAULT '[]'::jsonb,error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query('CREATE INDEX IF NOT EXISTS submissions_user_id_idx ON submissions(user_id,created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS submissions_problem_score_idx ON submissions(problem_slug,user_id,status,score,created_at)');
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
app.get('/api/contests', (_req, res) => res.json({ contests: [] }));
app.get('/api/leaderboard', asyncRoute(async (_req, res) => {
    const q = await pool.query(`SELECT u.username,u.avatar,COUNT(DISTINCT s.problem_slug) FILTER(WHERE s.status='accepted')::int AS solved,COUNT(s.id)::int AS attempts
        FROM users u LEFT JOIN submissions s ON u.id=s.user_id AND s.kind='code' WHERE u.role<>'admin' GROUP BY u.id ORDER BY solved DESC,attempts ASC,u.username LIMIT 50`);
    res.json({ users: q.rows });
}));
app.get('/api/submissions', auth, asyncRoute(async (req, res) => {
    const slug = typeof req.query.slug === 'string' ? req.query.slug : null;
    const fields = `s.id,s.problem_slug,s.kind,s.status,s.passed,s.total,
        CASE WHEN s.kind='code' AND s.total>0 THEN s.passed::double precision*100/s.total ELSE s.score END AS score,
        CASE WHEN s.kind='code' THEN 'AC rate' ELSE s.metric END AS metric,s.created_at,
        COALESCE(p.data->>'title',s.problem_slug) AS problem_title,
        COALESCE(p.data->>'category',CASE WHEN s.kind='csv' THEN 'AI Track' ELSE 'Function Only' END) AS problem_category`;
    const q = slug
        ? await pool.query(`SELECT ${fields} FROM submissions s LEFT JOIN problems p ON p.slug=s.problem_slug WHERE s.user_id=$1 AND s.problem_slug=$2 ORDER BY s.created_at DESC LIMIT 100`, [req.user.id, slug])
        : await pool.query(`SELECT ${fields} FROM submissions s LEFT JOIN problems p ON p.slug=s.problem_slug WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 100`, [req.user.id]);
    res.json({ submissions: q.rows });
}));
app.get('/api/submissions/:id', auth, asyncRoute(async (req, res) => { const s = await getSubmission(req.params.id, req.user.id); if (!s) return res.status(404).json({ error: 'Not found' }); res.json({ submission: s }) }));
app.get('/api/problems/:slug/solutions', asyncRoute(async (req, res) => {
    const problem = await findProblem(req.params.slug);
    if (!problem) return res.status(404).json({ error: 'Problem not found' });
    const q = await pool.query(`SELECT s.id,s.kind,s.status,s.passed,s.total,
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
            SELECT s.id,s.user_id,s.score,s.created_at,u.username,u.avatar,a.attempts,
                ROW_NUMBER() OVER (PARTITION BY s.user_id ORDER BY s.score ${direction},s.created_at ASC,s.id ASC) AS user_rank
            FROM submissions s
            JOIN users u ON u.id=s.user_id
            JOIN attempts a ON a.user_id=s.user_id
            WHERE s.problem_slug=$1 AND s.kind='csv' AND s.status='accepted' AND s.score IS NOT NULL AND u.role<>'admin'
        ), placed AS (
            SELECT id AS best_submission_id,username,avatar,score,attempts,created_at AS achieved_at,
                (ROW_NUMBER() OVER (ORDER BY score ${direction},created_at ASC,username ASC))::int AS rank,
                COUNT(*) OVER ()::int AS total_participants
            FROM best WHERE user_rank=1
        )
        SELECT * FROM placed ORDER BY rank LIMIT $2 OFFSET $3`, [problem.slug, limit, offset]);
    const totalParticipants = q.rows[0]?.total_participants || 0;
    res.json({
        metric: problem.metric,
        greater_is_better: Boolean(problem.config?.greater_is_better),
        page,
        limit,
        total_participants: totalParticipants,
        entries: q.rows.map(({ total_participants, ...entry }) => entry),
    });
}));
app.post('/api/submissions/code', auth, rateLimit({ windowMs: 60000, limit: 12 }), asyncRoute(async (req, res) => {
    const { slug, code } = req.body || {}; const p = await findProblem(slug);
    if (!p || p.kind !== 'code' || typeof code !== 'string' || !code.trim() || code.length > 50000) return res.status(400).json({ error: 'Invalid code submission' });
    if (queue.length >= MAX_QUEUE) return res.status(503).json({ error: 'Judge queue full' });
    const id = randomUUID(); await pool.query('INSERT INTO submissions(id,user_id,problem_slug,kind,code,total) VALUES($1,$2,$3,$4,$5,$6)', [id, req.user.id, slug, 'code', code, p.tests.length]);
    enqueue(() => gradeCode(id, p, code)); res.status(202).json({ id, status: 'queued' });
}));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
app.post('/api/submissions/csv', auth, rateLimit({ windowMs: 60000, limit: 12 }), upload.single('file'), asyncRoute(async (req, res) => {
    const p = await findProblem(req.body.slug);
    if (!p || p.kind !== 'csv' || !req.file || !req.file.originalname.toLowerCase().endsWith('.csv')) return res.status(400).json({ error: 'Select a valid CSV problem and .csv file' });
    if (queue.length >= MAX_QUEUE) return res.status(503).json({ error: 'Judge queue full' });
    const id = randomUUID(); await pool.query('INSERT INTO submissions(id,user_id,problem_slug,kind,total) VALUES($1,$2,$3,$4,1)', [id, req.user.id, p.slug, 'csv']);
    enqueue(() => gradeCsv(id, p.slug, req.file.buffer)); res.status(202).json({ id, status: 'queued' });
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
        const client=await pool.connect();
        try {
            await client.query('BEGIN');
            for(const problem of problems) await client.query('INSERT INTO problems(slug,data) VALUES($1,$2::jsonb)',[problem.slug,JSON.stringify(problem)]);
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
            try { await pool.query('INSERT INTO problems(slug,data) VALUES($1,$2::jsonb)', [data.slug, JSON.stringify(data)]); }
            catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'Slug already exists' }); throw error; }
        }
        res.status(editing ? 200 : 201).json({ problem: publicProblem(data), data_files: data.kind === 'csv' ? await publicDataFiles(data.slug) : [] });
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
app.use(async (err, req, res, _next) => {
    await cleanupUploads(req);
    console.error(err);
    const uploadLimit = ['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(err.code);
    res.status(uploadLimit ? 413 : 500).json({ error: uploadLimit ? `Upload exceeds the ${datasetMaxMb} MB challenge limit or allowed file count` : 'Request failed' });
});
await initialize(); server.listen(Number(process.env.PORT || 4000), '0.0.0.0', () => console.log('Platform API listening'));
