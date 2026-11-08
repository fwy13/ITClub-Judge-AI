import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProblemText, publicStarter } from './problem-rules.js';

test('returns the complete stored starter code without rewriting it', () => {
    const starter = `import numpy as np

def mixup(
    image1: list,
    image2: list,
    lam: float
) -> np.ndarray:
    image1 = np.asarray(image1, dtype=float)
    # Your code here
    pass
`;
    assert.equal(publicStarter({ kind: 'code', starter }), starter);
});

test('does not expose starter code for CSV exercises', () => {
    assert.equal(publicStarter({ kind: 'csv', starter: 'private' }), '');
});

test('normalizes browser multipart line endings to LF', () => {
    assert.equal(normalizeProblemText('def solve():\r\n    pass\r\n'), 'def solve():\n    pass\n');
    assert.equal(publicStarter({ kind: 'code', starter: 'def solve():\r\n    pass' }), 'def solve():\n    pass');
});
