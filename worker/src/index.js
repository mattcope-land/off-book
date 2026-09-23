// POST /extract                                      (passcode)
//   body: { mode: 'script', scene?, context?, pages: [{ text } | { image: dataURL }] }
//   returns: { entries: [{ scene, speaker, text }], characters: [{ name, gender }], truncated }
//   Every speech in the pages, plus stage directions between speeches (speaker "").
//   Without mode: { character, aliases?, includeGroup?, ... } returns one character's
//   { lines: [{ scene, cue, line }] } (used by app versions before whole-script import).
//
//   The app sends a long script in several requests; `scene` and `context` carry the
//   current scene heading and the end of the previous section across the boundary.
//
// POST /shows                                        (passcode)
//   body: { title, entries, characters }  ->  { id }
// GET /shows/:id                                     (no passcode: the ID is the secret)
//   returns the show, for cast members opening a share link
//
// POST /speak                                        (passcode, or a show the text is in)
//   body: { voice, text, show? }
//   returns: MP3 audio of the text read by that voice

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

const SCRIPT_SCHEMA = {
    type: 'object',
    properties: {
        entries: {
            type: 'array',
            items: {
                type: 'object',
                properties: { scene: { type: 'string' }, speaker: { type: 'string' }, text: { type: 'string' } },
                required: ['scene', 'speaker', 'text'],
                additionalProperties: false
            }
        },
        characters: {
            type: 'array',
            items: {
                type: 'object',
                properties: { name: { type: 'string' }, gender: { type: 'string', enum: ['female', 'male', 'unknown'] } },
                required: ['name', 'gender'],
                additionalProperties: false
            }
        }
    },
    required: ['entries', 'characters'],
    additionalProperties: false
};

const SCRIPT_INSTRUCTIONS = `You turn a stage play or musical script into structured data so student actors can learn their lines.

Return JSON: {"entries": [{"scene": "...", "speaker": "...", "text": "..."}], "characters": [{"name": "...", "gender": "..."}]}.

entries, in script order:
- One entry per speech. speaker: the character's label as written, without trailing punctuation (e.g. "PUCK", "LADY MACBETH"). Use the same spelling for the same character every time. Groups such as ALL or CHORUS are speakers too.
- text: everything spoken or sung in that speech, exactly as written. Join wrapped lines with spaces. Leave out the speaker label and any stage directions inside the speech.
- A stage direction that comes between two speeches (an entrance, exit, action or sound) gets its own entry with speaker "" and the direction in square brackets, e.g. "[Enter OBERON]".
- scene: the most recent act/scene heading exactly as written (e.g. "Act 1, Scene 2"), or "" if there is none.
- Copy the words exactly; do not fix grammar, modernize spelling or summarize.
- Skip title pages, character lists, headers, footers and page numbers.

characters: every speaker in the entries, once each. gender: "female" or "male" if the script makes it clear (pronouns, titles such as Lord or Queen, character descriptions), otherwise "unknown". Groups are "unknown".

If there is no script text, return {"entries": [], "characters": []}.`;

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
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

async function readPages(body, env) {
    const pages = Array.isArray(body.pages) ? body.pages : [];
    if (!pages.length) throw new HttpError(400, 'No pages were sent.');
    const images = pages.filter(p => typeof p.image === 'string');
    if (images.length > MAX_IMAGES) throw new HttpError(400, `Send at most ${MAX_IMAGES} images per request.`);
    if (images.some(p => !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(p.image))) throw new HttpError(400, 'Images must be PNG, JPEG, WebP or GIF.');
    const texts = pages.filter(p => typeof p.text === 'string').map(p => p.text);
    if (images.length) texts.push(await transcribe(env, images));
    return texts.join('\n\n').slice(0, MAX_TEXT_CHARS);
}

function sectionPreamble(body) {
    const scene = str(body.scene, 200);
    const context = str(body.context, 2000);
    let preamble = '';
    if (scene) preamble += `This section starts in the scene headed "${scene}".\n`;
    if (context) preamble += `The previous section ended with the text below. It is context only: do not include it in your answer.\n---\n${context}\n---\n`;
    return preamble + 'Here is the script text:';
}

const tidySpeaker = v => tidy(v, 100).replace(/[.:]+$/, '').trim();

function cleanEntries(list) {
    return (Array.isArray(list) ? list : [])
        .map(e => {
            const speaker = tidySpeaker(e?.speaker);
            let text = tidy(e?.text, 5000);
            if (speaker) text = text.replace(SPEAKER_LABEL, '');
            else if (text && !/^\[.*\]$/.test(text)) text = `[${text.replace(/^[([]|[)\]]$/g, '')}]`;
            return { scene: tidy(e?.scene, 200), speaker, text };
        })
        .filter(e => e.text);
}

function cleanCharacters(list) {
    const seen = new Map();
    for (const c of Array.isArray(list) ? list : []) {
        const name = tidySpeaker(c?.name);
        if (!name || seen.has(name.toUpperCase())) continue;
        seen.set(name.toUpperCase(), { name, gender: ['female', 'male'].includes(c?.gender) ? c.gender : 'unknown' });
    }
    return [...seen.values()];
}

async function extractScript(body, env) {
    const text = await readPages(body, env);
    const { content, finishReason } = await callModel(env, [
        { role: 'system', content: SCRIPT_INSTRUCTIONS },
        { role: 'user', content: [{ type: 'text', text: sectionPreamble(body) }, { type: 'text', text }] }
    ], { max_tokens: 32000, response_format: { type: 'json_schema', json_schema: { name: 'Script', schema: SCRIPT_SCHEMA } } });

    let parsed;
    try { parsed = JSON.parse(content); }
    catch {
        // Cut off mid-JSON: the app splits the section and tries again
        if (finishReason === 'length') return { entries: [], characters: [], truncated: true };
        throw new HttpError(502, 'The AI response could not be read. Try again.');
    }
    return { entries: cleanEntries(parsed.entries), characters: cleanCharacters(parsed.characters), truncated: finishReason === 'length' };
}

class HttpError extends Error {
    constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// --- Shows shared with a cast ---

const SHOW_ID = /^[A-Za-z0-9]{12}$/;
const MAX_SHOW_ENTRIES = 8000;

function newShowId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return [...bytes].map(b => chars[b % chars.length]).join('');
}

async function createShow(body, env) {
    const title = tidy(body.title, 200);
    const entries = cleanEntries(body.entries);
    if (!title) throw new HttpError(400, 'The show needs a title.');
    if (!entries.length) throw new HttpError(400, 'The show has no lines.');
    if (entries.length > MAX_SHOW_ENTRIES) throw new HttpError(413, 'That script is too long to share.');
    const id = newShowId();
    await env.SHOWS.put(`show:${id}`, JSON.stringify({ title, entries, characters: cleanCharacters(body.characters), created: Date.now() }));
    return { id };
}

async function getShow(id, env) {
    return SHOW_ID.test(id) ? env.SHOWS.get(`show:${id}`, 'json') : null;
}

// Must match CLOUD_VOICES in app.js
const VOICES = new Set(['aurora', 'ophelia', 'andromeda', 'luna', 'iris', 'helena', 'pandora',
    'hermes', 'apollo', 'aries', 'jupiter', 'draco', 'hyperion', 'zeus']);
const MAX_SPEAK_CHARS = 1500;

async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function speak(body, env, ctx, ip, headers, hasPasscode) {
    const text = tidy(body.text, MAX_SPEAK_CHARS);
    if (!text) throw new HttpError(400, 'No text to speak.');
    if (!VOICES.has(body.voice)) throw new HttpError(400, 'Unknown voice.');
    // Without the passcode, only lines from a shared show can be read, so a share link can't be used to generate anything else
    if (!hasPasscode) {
        const show = typeof body.show === 'string' ? await getShow(body.show, env) : null;
        if (!show || !show.entries.some(e => tidy(e.text, MAX_SPEAK_CHARS) === text)) throw new HttpError(401, 'Wrong passcode.');
    }

    const audioHeaders = { ...headers, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=31536000' };
    const key = `${env.TTS_MODEL}:${body.voice}:${await sha256(text)}`;
    const cached = await env.TTS_CACHE.get(key, 'arrayBuffer');
    if (cached) return new Response(cached, { headers: audioHeaders });

    if (env.SPEAK_LIMITER && !(await env.SPEAK_LIMITER.limit({ key: ip })).success) {
        throw new HttpError(429, 'Too many requests. Wait a minute and try again.', 'rate');
    }

    let audio;
    try {
        const out = await env.AI.run(env.TTS_MODEL, { text, speaker: body.voice, encoding: 'mp3' });
        audio = await new Response(out).arrayBuffer();
    } catch (e) {
        console.error('TTS error', e?.message);
        // On the free plan, Workers AI refuses requests once the daily allowance is used up
        if (/neuron|allocation|4006|quota|limit/i.test(e?.message || '')) {
            throw new HttpError(429, "Natural voices have reached today's limit.", 'daily-limit');
        }
        throw new HttpError(502, "Couldn't create the voice. Try again.");
    }
    if (!audio.byteLength) throw new HttpError(502, "Couldn't create the voice. Try again.");

    // KV writes can fail (e.g. the free plan's daily write limit); the audio is still returned
    ctx.waitUntil(env.TTS_CACHE.put(key, audio).catch(e => console.error('KV put failed', e?.message)));
    return new Response(audio, { headers: audioHeaders });
}

export default {
    async fetch(request, env, ctx) {
        const headers = cors(request.headers.get('Origin') || '', env);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

        const url = new URL(request.url);
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const hasPasscode = !!env.PASSCODE && safeEqual(request.headers.get('X-Passcode') || '', env.PASSCODE);

        const showMatch = url.pathname.match(/^\/shows\/([^/]+)$/);
        if (showMatch && request.method === 'GET') {
            const show = await getShow(showMatch[1], env);
            return show ? json(show, 200, { ...headers, 'Cache-Control': 'public, max-age=300' }) : json({ error: "That show link isn't valid." }, 404, headers);
        }

        if (!['/extract', '/speak', '/shows'].includes(url.pathname) || request.method !== 'POST') return json({ error: 'Not found' }, 404, headers);

        if (url.pathname === '/speak') {
            try {
                return await speak(await request.json(), env, ctx, ip, headers, hasPasscode);
            } catch (e) {
                if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status, headers);
                console.error(e);
                return json({ error: "Couldn't create the voice. Try again." }, 500, headers);
            }
        }

        if (!hasPasscode) return json({ error: 'Wrong passcode.' }, 401, headers);

        if (env.LIMITER) {
            const { success } = await env.LIMITER.limit({ key: ip });
            if (!success) return json({ error: 'Too many requests. Wait a minute and try again.', code: 'rate' }, 429, headers);
        }

        if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) {
            return json({ error: 'Too much at once. Try fewer or smaller pages.' }, 413, headers);
        }

        try {
            const raw = await request.text();
            if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, 'Too much at once. Try fewer or smaller pages.');
            let body;
            try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid request.'); }
            if (url.pathname === '/shows') return json(await createShow(body, env), 200, headers);
            return json(await (body.mode === 'script' ? extractScript(body, env) : extract(body, env)), 200, headers);
        } catch (e) {
            if (e instanceof HttpError) return json({ error: e.message }, e.status, headers);
            console.error(e);
            return json({ error: 'Something went wrong. Try again.' }, 500, headers);
        }
    }
};
