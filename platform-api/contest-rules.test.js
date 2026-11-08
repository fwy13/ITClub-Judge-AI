import test from 'node:test';
import assert from 'node:assert/strict';
import { contestAcceptsSubmissions, contestProblemLabel, effectiveContestStatus, roleCanEnterContest } from './contest-rules.js';

test('contest status expires from server time', () => {
    const now = new Date('2026-11-08T12:00:00Z');
    assert.equal(effectiveContestStatus({ status: 'open', end_at: '2026-11-08T11:59:59Z' }, now), 'ended');
    assert.equal(effectiveContestStatus({ status: 'open', end_at: '2026-11-08T12:30:00Z' }, now), 'open');
});

test('a contest is closed before the organizer opens it', () => {
    assert.equal(effectiveContestStatus({ status: 'closed', end_at: null }), 'closed');
    assert.equal(effectiveContestStatus({}), 'closed');
});

test('contest roles match the contest type', () => {
    assert.equal(roleCanEnterContest('code', 'student'), true);
    assert.equal(roleCanEnterContest('code', 'team'), false);
    assert.equal(roleCanEnterContest('csv', 'team'), true);
    assert.equal(roleCanEnterContest('csv', 'student'), false);
    assert.equal(roleCanEnterContest('csv', 'admin'), true);
});

test('submissions require the active server-side time window', () => {
    const now = new Date('2026-11-08T12:00:00Z');
    assert.equal(contestAcceptsSubmissions({ status: 'open', start_at: '2026-11-08T11:00:00Z', end_at: '2026-11-08T13:00:00Z' }, now), true);
    assert.equal(contestAcceptsSubmissions({ status: 'open', start_at: '2026-11-08T11:00:00Z', end_at: '2026-11-08T12:00:00Z' }, now), false);
});

test('problem labels continue after Z', () => {
    assert.equal(contestProblemLabel(0), 'A');
    assert.equal(contestProblemLabel(25), 'Z');
    assert.equal(contestProblemLabel(26), 'AA');
});
