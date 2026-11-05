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
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) throw Error('JWT_SECRET must be at least 32 characters');
const app = express();
app.disable('x-powered-by'); app.use(helmet()); app.use(express.json({ limit: '300kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, standardHeaders: 'draft-7', legacyHeaders: false }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });
const sockets = new Map();
const queue = []; let active = 0; const MAX_ACTIVE = 2; const MAX_QUEUE = 200;
const workerUrl = process.env.RUST_WORKER_URL || 'http://rust-worker:3001';
const csvUrl = process.env.CSV_JUDGE_URL || 'http://csv-judge:8100';
const publicProblem = p => ({ slug: p.slug, title: p.title, category: p.category, difficulty: p.difficulty, kind: p.kind, description: p.description, starter: p.starter, metric: p.metric, sample_tests: p.tests.slice(0, 1).map(t => ({ args: t.args, expected: t.expected })) });
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const tokenFor = user => jwt.sign({ id: user.id, username: user.username, role: user.role || 'student' }, secret, { expiresIn: '12h', issuer: 'itclub-judge' });
const verify = token => jwt.verify(token, secret, { issuer: 'itclub-judge' });
function auth(req, res, next) { try { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); req.user = verify(t); next() } catch { res.status(401).json({ error: 'Authentication required' }) } }
async function admin(req, res, next) {
    try { const q = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id]); if (q.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' }); next() } catch (e) { next(e) }
}
function send(socket, payload) { if (socket.readyState === 1) socket.send(JSON.stringify(payload)) }
function broadcast(id, event) { for (const ws of sockets.get(id) || []) send(ws, event) }
function subscribe(ws, id) { let s = sockets.get(id); if (!s) { s = new Set(); sockets.set(id, s) } s.add(ws); ws._subscriptions.add(id) }
async function getSubmission(id, uid) { const q = await pool.query('SELECT id,problem_slug,kind,status,passed,total,score,metric,results,error,created_at FROM submissions WHERE id=$1 AND user_id=$2', [id, uid]); return q.rows[0] || null }
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
        await update(id, { passed, total: tests.length, results: JSON.stringify(results), status: 'running' }, 'test_completed');
    }
    await update(id, { status: passed === tests.length ? 'accepted' : 'failed', passed, total: tests.length, results: JSON.stringify(results) }, 'completed');
}
async function gradeCsv(id, slug, buffer) {
    try {
        const { data } = await axios.post(csvUrl + '/grade/' + encodeURIComponent(slug), buffer, { headers: { 'Content-Type': 'text/csv', 'X-Internal-Key': process.env.CSV_INTERNAL_KEY }, timeout: 120000, maxBodyLength: 12 * 1024 * 1024 });
        await update(id, { status: data.status === 'accepted' ? 'accepted' : 'failed', score: data.score ?? null, metric: data.metric ?? null, error: data.message ?? null, results: JSON.stringify([data]), passed: data.status === 'accepted' ? 1 : 0, total: 1 }, 'completed');
    } catch (e) { await update(id, { status: 'failed', error: String(e.response?.data?.detail || e.message).slice(0, 500) }, 'completed') }
}
const seededProblems = JSON.parse(await readFile(new URL('./problems.json', import.meta.url), 'utf8'));
async function listProblems() { const q = await pool.query('SELECT data FROM problems WHERE active=true ORDER BY created_at,slug'); return q.rows.map(r => r.data) }
async function findProblem(slug) { const q = await pool.query('SELECT data FROM problems WHERE slug=$1 AND active=true', [slug]); return q.rows[0]?.data || null }
const csvRoot = process.env.CSV_PROBLEMS_DIR || '/data/csv-problems';
const csvMetrics = { binary_probability: ['log_loss', 'accuracy', 'f1', 'precision', 'recall', 'balanced_accuracy'], multiclass_probability: ['log_loss', 'accuracy', 'macro_f1', 'macro_precision', 'macro_recall'], multilabel_probability: ['micro_f1', 'macro_f1', 'hamming_loss'], regression: ['rmse', 'mae', 'mse', 'r2', 'mape', 'smape'], ranking: ['ndcg_at_k', 'mrr', 'map', 'recall_at_k'], text_generation: ['sacrebleu', 'chrf'] };
const validateSlug = s => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 80;
const validText = (s, max = 10000) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
function parseJson(v) { if (typeof v === 'object' && v !== null) return v; try { return JSON.parse(v || '') } catch { return null } }
function problemFields(body) {
    const slug = String(body.slug || ''), title = String(body.title || ''), description = String(body.description || ''), kind = body.kind;
    if (!validateSlug(slug) || !validText(title, 160) || !validText(description, 12000) || !['code', 'csv'].includes(kind)) throw Error('Invalid slug, title, description or type');
    const difficulty = ['Easy', 'Medium', 'Hard'].includes(body.difficulty) ? body.difficulty : 'Medium';
    const base = { slug, title, description, kind, difficulty, category: String(body.category || 'General').slice(0, 80) };
    if (kind === 'code') {
        const tests = parseJson(body.tests); if (!Array.isArray(tests) || tests.length < 1 || tests.length > 100 || !tests.every(t => t && Array.isArray(t.args) && Object.hasOwn(t, 'expected'))) throw Error('Tests must be an array (1–100) of {args, expected}');
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
    await pool.query(`CREATE TABLE IF NOT EXISTS users(id UUID PRIMARY KEY,username VARCHAR(40) NOT NULL UNIQUE,email VARCHAR(255) NOT NULL UNIQUE,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'student'");
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
}
app.get('/api/health', (_req, res) => res.json({ status: 'ok', services: ['auth-api', 'rust-worker', 'csv-judge'] }));
app.post('/api/auth/register', asyncRoute(async (req, res) => {
    const { username, email, password } = req.body || {};
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,40}$/.test(username) || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || email.length > 255 || typeof password !== 'string' || password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Username: 3–40 letters/numbers/_. Valid email and password length 10–128 required.' });
    const hash = await bcrypt.hash(password, 12); const id = randomUUID();
    try { await pool.query('INSERT INTO users(id,username,email,password_hash) VALUES($1,$2,$3,$4)', [id, username, email.toLowerCase(), hash]); }
    catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Username or email already exists' }); throw e }
    res.status(201).json({ token: tokenFor({ id, username, role: 'student' }), user: { id, username, email: email.toLowerCase(), role: 'student' } });
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Invalid credentials' });
    const q = await pool.query('SELECT * FROM users WHERE username=$1 OR email=$1 LIMIT 1', [username]); const u = q.rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ token: tokenFor(u), user: { id: u.id, username: u.username, email: u.email, role: u.role } });
}));
app.get('/api/auth/me', auth, asyncRoute(async (req, res) => { const q = await pool.query('SELECT id,username,email,role FROM users WHERE id=$1', [req.user.id]); res.json({ user: q.rows[0] }) }));
app.get('/api/problems', asyncRoute(async (_req, res) => res.json({ problems: (await listProblems()).map(publicProblem) })));
app.get('/api/problems/:slug', asyncRoute(async (req, res) => { const p = await findProblem(req.params.slug); if (!p) return res.status(404).json({ error: 'Not found' }); res.json({ problem: publicProblem(p) }) }));
app.get('/api/contests', (_req, res) => res.json({ contests: [] }));
app.get('/api/leaderboard', asyncRoute(async (_req, res) => {
    const q = await pool.query(`SELECT u.username, count(*) FILTER(WHERE s.status='accepted')::int AS accepted, count(s.id)::int AS attempts FROM users u LEFT JOIN submissions s ON u.id=s.user_id GROUP BY u.id ORDER BY accepted DESC, attempts ASC, u.username LIMIT 50`);
    res.json({ users: q.rows });
}));
app.get('/api/submissions', auth, asyncRoute(async (req, res) => { const q = await pool.query('SELECT id,problem_slug,kind,status,passed,total,score,metric,created_at FROM submissions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id]); res.json({ submissions: q.rows }) }));
app.get('/api/submissions/:id', auth, asyncRoute(async (req, res) => { const s = await getSubmission(req.params.id, req.user.id); if (!s) return res.status(404).json({ error: 'Not found' }); res.json({ submission: s }) }));
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
const adminUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 2, fields: 30 } });
app.get('/api/admin/problems', auth, admin, asyncRoute(async (_req, res) => {
    const rows = await pool.query('SELECT slug,active,data,created_at,updated_at FROM problems ORDER BY created_at DESC');
    res.json({ problems: rows.rows.map(r => ({ ...r.data, active: r.active, created_at: r.created_at, updated_at: r.updated_at })) });
}));
app.get('/api/admin/problems/:slug', auth, admin, asyncRoute(async (req, res) => {
    const q = await pool.query('SELECT data,active FROM problems WHERE slug=$1', [req.params.slug]);
    if (!q.rowCount) return res.status(404).json({ error: 'Not found' }); res.json({ problem: { ...q.rows[0].data, active: q.rows[0].active } });
}));
async function saveProblem(req, res, editing = false) {
    let data; try { data = problemFields(req.body) } catch (e) { return res.status(400).json({ error: e.message }) }
    if (editing && data.slug !== req.params.slug) return res.status(400).json({ error: 'Slug cannot be changed' });
    const existing = await pool.query('SELECT data FROM problems WHERE slug=$1', [data.slug]);
    if (!editing && existing.rowCount) return res.status(409).json({ error: 'Slug already exists' });
    if (editing && (!existing.rowCount || existing.rows[0].data.kind !== data.kind)) return res.status(400).json({ error: 'Problem not found or kind cannot be changed' });
    if (data.kind === 'csv') {
        const truth = req.files?.ground_truth?.[0], sample = req.files?.sample_submission?.[0];
        const hasDynamicTruth = await import('node:fs').then(m => m.existsSync(path.join(csvRoot, data.slug, 'ground_truth.csv')));
        if (editing && !truth && !hasDynamicTruth) return res.status(400).json({ error: 'Upload ground truth CSV when editing a bundled CSV problem' });
        if (!editing && !truth) return res.status(400).json({ error: 'Ground truth CSV required' });
        if (truth && (!truth.originalname.toLowerCase().endsWith('.csv') || !truth.buffer.length)) return res.status(400).json({ error: 'Invalid ground truth CSV' });
        if (sample && !sample.originalname.toLowerCase().endsWith('.csv')) return res.status(400).json({ error: 'Invalid sample CSV' });
        const dir = path.join(csvRoot, data.slug); await mkdir(dir, { recursive: true });
        // Atomic file replacements prevent the scorer from reading partially written files.
        async function put(name, buf) { const tmp = path.join(dir, `.${name}.${randomUUID()}.tmp`); await writeFile(tmp, buf, { mode: 0o644 }); await rename(tmp, path.join(dir, name)) }
        await put('config.json', Buffer.from(JSON.stringify(data.config)));
        if (truth) await put('ground_truth.csv', truth.buffer);
        if (sample) await put('sample_submission.csv', sample.buffer);
        // Full configuration is retained for admin editing but omitted from publicProblem().
    }
    if (editing) { const r = await pool.query('UPDATE problems SET data=$2::jsonb,active=true,updated_at=now() WHERE slug=$1 RETURNING slug', [data.slug, JSON.stringify(data)]); if (!r.rowCount) return res.status(404).json({ error: 'Problem not found' }); }
    else { try { await pool.query('INSERT INTO problems(slug,data) VALUES($1,$2::jsonb)', [data.slug, JSON.stringify(data)]) } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Slug already exists' }); throw e } }
    res.status(editing ? 200 : 201).json({ problem: publicProblem(data) });
}
app.post('/api/admin/problems', auth, admin, rateLimit({ windowMs: 60000, limit: 20 }), adminUpload.fields([{ name: 'ground_truth', maxCount: 1 }, { name: 'sample_submission', maxCount: 1 }]), asyncRoute(async (req, res) => saveProblem(req, res)));
app.put('/api/admin/problems/:slug', auth, admin, rateLimit({ windowMs: 60000, limit: 20 }), adminUpload.fields([{ name: 'ground_truth', maxCount: 1 }, { name: 'sample_submission', maxCount: 1 }]), asyncRoute(async (req, res) => saveProblem(req, res, true)));
app.delete('/api/admin/problems/:slug', auth, admin, asyncRoute(async (req, res) => {
    const q = await pool.query('UPDATE problems SET active=false,updated_at=now() WHERE slug=$1 RETURNING slug', [req.params.slug]);
    if (!q.rowCount) return res.status(404).json({ error: 'Not found' }); res.json({ ok: true });
}));
app.use((err, _req, res, _next) => { console.error(err); res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 500).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'CSV too large' : 'Request failed' }) });
await initialize(); server.listen(Number(process.env.PORT || 4000), '0.0.0.0', () => console.log('Platform API listening'));
