import assert from 'node:assert/strict';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const base = `http://127.0.0.1:${process.env.PORT || 4000}/api`;
const suffix = Date.now().toString(36);
const problemSlug = `contest-smoke-problem-${suffix}`;
const importedProblemSlug = `contest-smoke-import-${suffix}`;
let contestSlug;
const username = `smoke_${suffix}`.slice(0, 40);
let userId;

async function api(path, options = {}, token = null) {
    const isForm = options.body instanceof FormData;
    const response = await fetch(base + path, {
        ...options,
        headers: { ...(!isForm ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(`${response.status} ${body.error || path}`);
    return body;
}

try {
    const admin = (await pool.query("SELECT id,username,role FROM users WHERE role='admin' LIMIT 1")).rows[0];
    assert.ok(admin, 'An admin account is required for the smoke test');
    const adminToken = jwt.sign(admin, process.env.JWT_SECRET, { expiresIn: '10m', issuer: 'itclub-judge' });
    const created = await api('/admin/contests', { method: 'POST', body: JSON.stringify({ title: `Contest smoke test ${suffix}`, type: 'code', password: 'smoke-pass', duration_minutes: 10, problem_slugs: [] }) }, adminToken);
    contestSlug = created.slug;
    const closedContest = (await api('/admin/contests', {}, adminToken)).contests.find(item => item.slug === contestSlug);
    assert.equal(closedContest?.status, 'closed');
    assert.equal((await api('/contests')).contests.some(item => item.slug === contestSlug && item.status === 'closed'), true, 'closed contest must appear in the contest list without exposing problems');
    const multilineStarter = 'def solve(\n    x: int\n) -> int:\n    # Your code here\n    pass';
    const problemForm = new FormData();
    Object.entries({
        slug: problemSlug,
        title: 'Contest smoke problem',
        category: 'Python',
        difficulty: 'Easy',
        kind: 'code',
        description: 'Return x * 2.',
        starter: multilineStarter,
        function: 'solve',
        class_name: '',
        tests: JSON.stringify([{ input: '3', output: '6' }]),
        contest_slug: contestSlug,
    }).forEach(([key, value]) => problemForm.set(key, value));
    await api('/admin/problems', { method: 'POST', body: problemForm }, adminToken);
    const importForm = new FormData();
    importForm.set('contest_slug', contestSlug);
    importForm.set('file', new Blob([
        `slug,title,category,difficulty,description,function,class_name,starter,input,output\n${importedProblemSlug},Imported contest smoke problem,Python,Easy,Return x * 3.,solve,,"def solve(x):\n    pass",3,9\n`,
    ], { type: 'text/csv' }), 'contest-problems.csv');
    const imported = await api('/admin/problems/import-csv', { method: 'POST', body: importForm }, adminToken);
    assert.equal(imported.imported, 1, 'bulk import must create one private contest problem');
    assert.equal((await api('/problems')).problems.some(item => item.slug === problemSlug), false, 'closed contest problem must be hidden');
    assert.equal((await api('/problems')).problems.some(item => item.slug === importedProblemSlug), false, 'bulk-imported closed contest problem must be hidden');
    const removed = await api(`/admin/contests/${contestSlug}/problems/${importedProblemSlug}`, { method: 'DELETE', body: JSON.stringify({ confirm_slug: importedProblemSlug }) }, adminToken);
    assert.equal(removed.ok, true, 'closed contest exercise must be deletable');
    await api(`/admin/contests/${contestSlug}/open`, { method: 'POST', body: '{}' }, adminToken);
    userId = randomUUID();
    await pool.query('INSERT INTO users(id,username,email,password_hash,role) VALUES($1,$2,$3,$4,$5)', [userId, username, `${username}@smoke.invalid`, await bcrypt.hash('smoke-password', 4), 'student']);
    const userToken = jwt.sign({ id: userId, username, role: 'student' }, process.env.JWT_SECRET, { expiresIn: '10m', issuer: 'itclub-judge' });
    assert.equal((await api(`/contests/${contestSlug}`, {}, userToken)).contest.can_access, false);
    await api(`/contests/${contestSlug}/join`, { method: 'POST', body: JSON.stringify({ password: 'smoke-pass' }) }, userToken);
    assert.equal((await api(`/contests/${contestSlug}`, {}, userToken)).contest.problems.length, 1);
    const contestProblem = await api(`/contests/${contestSlug}/problems/${problemSlug}`, {}, userToken);
    assert.equal(contestProblem.problem.starter, multilineStarter, 'submit template must exactly match the stored starter code');
    const submission = await api('/submissions/code', { method: 'POST', body: JSON.stringify({ slug: problemSlug, contest_slug: contestSlug, code: 'def solve(x):\n    return x * 2' }) }, userToken);
    let current;
    for (let attempt = 0; attempt < 30; attempt += 1) {
        current = (await api(`/submissions/${submission.id}`, {}, userToken)).submission;
        if (!['queued', 'running'].includes(current.status)) break;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    const board = await api(`/contests/${contestSlug}/leaderboard`, {}, userToken);
    assert.equal(board.entries[0]?.total, 100, 'best contest score must reach the leaderboard');
    assert.equal(board.entries[0]?.scores?.A?.first_solve, true, 'first full-score solve must be marked');
    assert.equal(Number.isFinite(board.entries[0]?.scores?.A?.elapsed_seconds), true, 'solve elapsed time must be reported');
    await api(`/admin/contests/${contestSlug}/end`, { method: 'POST', body: '{}' }, adminToken);
    assert.equal((await api(`/contests/${contestSlug}`)).contest.can_access, true, 'ended contest must be public');
    assert.equal((await api('/problems')).problems.some(item => item.slug === problemSlug), true, 'ended problem must be published');
    const deletedContest = await api(`/admin/contests/${contestSlug}`, { method: 'DELETE', body: JSON.stringify({ confirm_slug: contestSlug }) }, adminToken);
    assert.equal(deletedContest.ok, true, 'ended contest must be deletable');
    assert.equal(deletedContest.retained_problems, 1, 'contest deletion must retain its exercise');
    assert.equal(deletedContest.retained_submissions, 1, 'contest deletion must retain submission history');
    assert.equal((await api('/contests')).contests.some(item => item.slug === contestSlug), false, 'deleted contest must disappear from the public list');
    assert.equal((await pool.query('SELECT contest_id FROM submissions WHERE id=$1', [submission.id])).rows[0]?.contest_id, null, 'retained submission must be detached from the deleted contest');
    console.log(`Contest smoke test passed: ${contestSlug}`);
} finally {
    if (process.env.KEEP_CONTEST_FIXTURE !== '1') {
        await pool.query('DELETE FROM submissions WHERE problem_slug=$1', [problemSlug]).catch(() => {});
        if (contestSlug) await pool.query('DELETE FROM contests WHERE slug=$1', [contestSlug]).catch(() => {});
        await pool.query('DELETE FROM problems WHERE slug=$1', [problemSlug]).catch(() => {});
        await pool.query('DELETE FROM problems WHERE slug=$1', [importedProblemSlug]).catch(() => {});
        if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => {});
    }
    await pool.end();
}
