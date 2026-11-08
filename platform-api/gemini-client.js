const DEFAULT_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

async function geminiRequest({ apiKey, path, body, signal, fetchImpl = fetch }) {
    const response = await fetchImpl(`${DEFAULT_API_ROOT}/${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message = payload?.error?.message || `Gemini API returned HTTP ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
    }
    return response;
}

export function parseSseBuffer(value, flush = false) {
    const normalized = value.replace(/\r\n/g, '\n');
    const chunks = normalized.split('\n\n');
    const rest = flush ? '' : chunks.pop() || '';
    const events = [];
    for (const chunk of chunks) {
        const data = chunk
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
        if (data && data !== '[DONE]') events.push(JSON.parse(data));
    }
    return { events, rest };
}

export function geminiChunk(payload) {
    const candidate = payload?.candidates?.[0] || {};
    const text = (candidate?.content?.parts || [])
        .filter(part => !part.thought && typeof part.text === 'string')
        .map(part => part.text)
        .join('');
    return {
        text,
        finishReason: candidate.finishReason || null,
        usageMetadata: payload?.usageMetadata || null,
    };
}

export async function countGeminiTokens({ apiKey, model, contents, signal, fetchImpl }) {
    const response = await geminiRequest({
        apiKey,
        path: `models/${encodeURIComponent(model)}:countTokens`,
        body: { contents },
        signal,
        fetchImpl,
    });
    const payload = await response.json();
    const total = Number(payload.totalTokens);
    if (!Number.isInteger(total) || total < 0) throw new Error('Gemini returned an invalid token count');
    return total;
}

export async function* streamGeminiResponse({
    apiKey,
    model,
    contents,
    maxOutputTokens,
    signal,
    fetchImpl,
}) {
    const response = await geminiRequest({
        apiKey,
        path: `models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        body: {
            contents,
            generationConfig: {
                maxOutputTokens,
                temperature: 0.7,
            },
        },
        signal,
        fetchImpl,
    });
    if (!response.body) throw new Error('Gemini returned an empty response stream');

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.rest;
        for (const payload of parsed.events) yield geminiChunk(payload);
    }
    buffer += decoder.decode();
    const parsed = parseSseBuffer(buffer, true);
    for (const payload of parsed.events) yield geminiChunk(payload);
}

