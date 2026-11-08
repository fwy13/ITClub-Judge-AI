import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiChunk, parseSseBuffer } from './gemini-client.js';

test('parses complete Gemini SSE events and preserves an incomplete tail', () => {
    const input = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n'
        + 'data: {"candidates":[{"content":{"parts":[{"text":" wor';
    const parsed = parseSseBuffer(input);
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0].candidates[0].content.parts[0].text, 'Hello');
    assert.match(parsed.rest, /wor$/);
});

test('extracts visible text while excluding thought parts', () => {
    const chunk = geminiChunk({
        candidates: [{
            finishReason: 'MAX_TOKENS',
            content: { parts: [{ text: 'hidden', thought: true }, { text: 'Visible answer' }] },
        }],
        usageMetadata: { candidatesTokenCount: 7 },
    });
    assert.equal(chunk.text, 'Visible answer');
    assert.equal(chunk.finishReason, 'MAX_TOKENS');
    assert.equal(chunk.usageMetadata.candidatesTokenCount, 7);
});

test('flushes the final SSE event even without a trailing separator', () => {
    const parsed = parseSseBuffer('data: {"usageMetadata":{"candidatesTokenCount":12}}', true);
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0].usageMetadata.candidatesTokenCount, 12);
    assert.equal(parsed.rest, '');
});

