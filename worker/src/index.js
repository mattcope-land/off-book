// POST /extract
//   headers: X-Passcode
//   body: { character, aliases?, includeGroup?, scene?, context?, pages: [{ text } | { image: dataURL }] }
//   returns: { lines: [{ scene, cue, line }] }
//
// The app sends a long script in several requests; `scene` and `context` carry the
// current scene heading and the end of the previous section across the boundary.

const MAX_IMAGES = 12;
const MAX_BODY_BYTES = 9_000_000; // Fireworks caps base64 images at 10MB per request
const MAX_TEXT_CHARS = 200_000;

const LINES_SCHEMA = {
    type: 'object',
    properties: {
        lines: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    scene: { type: 'string' },
                    cue: { type: 'string' },
                    line: { type: 'string' }
                },
                required: ['scene', 'cue', 'line'],
                additionalProperties: false
            }
        }
    },
    required: ['lines'],
    additionalProperties: false
};

function instructions({ character, aliases, includeGroup }) {
    const names = [character, ...aliases].map(n => `"${n}"`).join(', ');
    return `You extract one character's lines from a stage play or musical script so a student actor can memorize them.

The character is ${names} (match the speaker label case-insensitively, including abbreviations of these names).

Return JSON: {"lines": [{"scene": "...", "cue": "...", "line": "..."}]}, one entry per speech by the character, in script order.

- line: everything the character says or sings in that speech, exactly as written. Join wrapped lines with spaces. Leave out the speaker label and stage directions (usually in parentheses, brackets or italics).
- cue: the words spoken just before this speech by another character: their whole speech if it is short, otherwise only its last sentence or two (at most about 30 words). Leave out the speaker label and stage directions. If only a stage direction comes between two of the character's speeches, use that direction in square brackets, e.g. "[She slams the door]". If the character speaks first in a scene, use "".
- scene: the most recent act/scene heading exactly as written (e.g. "Act 1, Scene 2"), or "" if there is none.
${includeGroup ? '- Also include lines for groups the character belongs to, such as ALL, EVERYONE, CHORUS or ENSEMBLE.\n' : '- Do not include lines for groups such as ALL or ENSEMBLE.\n'}- Copy the words exactly; do not fix grammar, modernize spelling or summarize.
- Skip headers, footers, page numbers and character lists.
- If the character has no lines in these pages, return {"lines": []}.`;
}

function cors(origin, env) {
    const allowed = env.ALLOWED_ORIGINS.split(',').map(s => s.trim());
    return {
        'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Passcode',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    };
}

function json(data, status, headers) {
    return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

// Compares in constant time so the passcode can't be guessed from response timing
function safeEqual(a, b) {
    const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
    let diff = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
    return diff === 0;
}

async function callModel(env, messages, extra = {}) {
    const res = await fetch(env.FIREWORKS_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.FIREWORKS_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: env.MODEL,
            messages,
            temperature: 0,
            max_tokens: 16000,
            // Thinking made requests take over a minute, with no accuracy gain for this task
            ...(env.REASONING_EFFORT ? { reasoning_effort: env.REASONING_EFFORT } : {}),
            ...extra
        })
    });
    if (!res.ok) {
        console.error('Fireworks error', res.status, (await res.text()).slice(0, 500));
        throw new HttpError(502, `The AI service returned an error (${res.status}). Try again, or with fewer pages.`);
    }
    const choice = (await res.json()).choices?.[0];
    return { content: choice?.message?.content ?? '', finishReason: choice?.finish_reason };
}

// Photos and scans are transcribed first, then go through the same extraction as text:
// doing both in one step missed lines.
async function transcribe(env, images) {
    const { content, finishReason } = await callModel(env, [{
        role: 'user',
        content: [
            { type: 'text', text: 'Transcribe these script pages exactly as plain text, in order. Keep every speaker label, stage direction, scene heading and line break. Output only the transcription.' },
            ...images.map(p => ({ type: 'image_url', image_url: { url: p.image } }))
        ]
    }]);
    if (finishReason === 'length') throw new HttpError(502, 'Too many pages in one go. Try fewer pages.');
    return content;
}

const str = (v, max) => (typeof v === 'string' ? v : '').trim().slice(0, max);
// The model sometimes keeps the page's line breaks or a speaker label despite the instructions
const tidy = (v, max) => str(v, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);
const SPEAKER_LABEL = /^[A-Z][A-Z'’\- ]{2,}[.:]\s+/;

async function extract(body, env) {
    const character = str(body.character, 100);
    if (!character) throw new HttpError(400, 'Enter the character name.');
    const aliases = (Array.isArray(body.aliases) ? body.aliases : []).map(a => str(a, 100)).filter(Boolean).slice(0, 10);
    const pages = Array.isArray(body.pages) ? body.pages : [];
    if (!pages.length) throw new HttpError(400, 'No pages were sent.');

    const images = pages.filter(p => typeof p.image === 'string');
    if (images.length > MAX_IMAGES) throw new HttpError(400, `Send at most ${MAX_IMAGES} images per request.`);
    if (images.some(p => !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(p.image))) throw new HttpError(400, 'Images must be PNG, JPEG, WebP or GIF.');

    const texts = pages.filter(p => typeof p.text === 'string').map(p => p.text);
    if (images.length) texts.push(await transcribe(env, images));
    const text = texts.join('\n\n').slice(0, MAX_TEXT_CHARS);
    const scene = str(body.scene, 200);
    const context = str(body.context, 2000);

    let preamble = '';
    if (scene) preamble += `This section starts in the scene headed "${scene}".\n`;
    if (context) preamble += `The previous section ended with the text below. It is context only: use it for the first cue if needed, but do not extract lines from it.\n---\n${context}\n---\n`;
    preamble += 'Extract the lines from this script text:';

    const { content, finishReason } = await callModel(env, [
        { role: 'system', content: instructions({ character, aliases, includeGroup: !!body.includeGroup }) },
        { role: 'user', content: [{ type: 'text', text: preamble }, { type: 'text', text }] }
    ], { response_format: { type: 'json_schema', json_schema: { name: 'CharacterLines', schema: LINES_SCHEMA } } });

    let parsed;
    try { parsed = JSON.parse(content); }
    catch { throw new HttpError(502, finishReason === 'length' ? 'Too many lines in one go. Try fewer pages.' : 'The AI response could not be read. Try again.'); }

    const lines = (Array.isArray(parsed.lines) ? parsed.lines : [])
        .map(l => ({ scene: tidy(l?.scene, 200), cue: tidy(l?.cue, 2000).replace(SPEAKER_LABEL, ''), line: tidy(l?.line, 5000) }))
        .filter(l => l.line);
    return { lines, truncated: finishReason === 'length' };
}

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

export default {
    async fetch(request, env) {
        const headers = cors(request.headers.get('Origin') || '', env);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

        const url = new URL(request.url);
        if (url.pathname !== '/extract' || request.method !== 'POST') return json({ error: 'Not found' }, 404, headers);

        if (!env.PASSCODE || !safeEqual(request.headers.get('X-Passcode') || '', env.PASSCODE)) {
            return json({ error: 'Wrong passcode.' }, 401, headers);
        }

        if (env.LIMITER) {
            const { success } = await env.LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
            if (!success) return json({ error: 'Too many requests. Wait a minute and try again.' }, 429, headers);
        }

        if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) {
            return json({ error: 'Too much at once. Try fewer or smaller pages.' }, 413, headers);
        }

        try {
            const raw = await request.text();
            if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, 'Too much at once. Try fewer or smaller pages.');
            let body;
            try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid request.'); }
            return json(await extract(body, env), 200, headers);
        } catch (e) {
            if (e instanceof HttpError) return json({ error: e.message }, e.status, headers);
            console.error(e);
            return json({ error: 'Something went wrong. Try again.' }, 500, headers);
        }
    }
};
