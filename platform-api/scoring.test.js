import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMetricScore, scoreScale } from './scoring.js';

test('normalizes a higher-is-better metric from baseline to perfect', () => {
    const problem = { metric: 'f1', config: { metric: 'f1', greater_is_better: true, baseline_score: 0.4 } };
    assert.equal(normalizeMetricScore(0.4, problem), 0);
    assert.ok(Math.abs(normalizeMetricScore(0.7, problem) - 50) < 1e-10);
    assert.equal(normalizeMetricScore(1, problem), 100);
    assert.equal(normalizeMetricScore(0.2, problem), 0);
});

test('normalizes a lower-is-better loss and clamps values', () => {
    const problem = { metric: 'rmse', config: { metric: 'rmse', greater_is_better: false, baseline_score: 0.8 } };
    assert.equal(normalizeMetricScore(0.8, problem), 0);
    assert.equal(normalizeMetricScore(0.4, problem), 50);
    assert.equal(normalizeMetricScore(0, problem), 100);
    assert.equal(normalizeMetricScore(1.2, problem), 0);
    assert.equal(normalizeMetricScore(-1, problem), 100);
});

test('rejects missing or invalid scales', () => {
    assert.equal(scoreScale({ metric: 'f1', config: { metric: 'f1', greater_is_better: true } }), null);
    assert.equal(scoreScale({ metric: 'f1', config: { metric: 'f1', greater_is_better: true, baseline_score: 1.2 } }), null);
});
