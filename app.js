// Learn Lines: learn your lines with a scene partner that reads your cues and checks your lines.
// Shows are stored in this browser (localStorage). The Worker (see worker/) adds script
// import, share links and natural voices.

// --- Setup ---

// Cloudflare Worker for script import, sharing and natural voices. Empty hides those features.
const WORKER = 'https://learn-lines-extract.mmcopeland.workers.dev';
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/';

// Deepgram Aura-2 voices on Workers AI; must match VOICES in worker/src/index.js
const CLOUD_VOICES = [
    ['aurora', 'Aurora: cheerful, expressive (female)', 'female'],
    ['ophelia', 'Ophelia: enthusiastic, expressive (female)', 'female'],
    ['andromeda', 'Andromeda: casual, expressive (female)', 'female'],
    ['luna', 'Luna: friendly, young (female)', 'female'],
    ['iris', 'Iris: cheerful, young (female)', 'female'],
    ['helena', 'Helena: warm, a little raspy (female)', 'female'],
    ['pandora', 'Pandora: calm, British (female)', 'narrator'],
    ['hermes', 'Hermes: expressive, engaging (male)', 'male'],
    ['apollo', 'Apollo: confident, casual (male)', 'male'],
    ['aries', 'Aries: warm, energetic (male)', 'male'],
    ['jupiter', 'Jupiter: expressive, deep (male)', 'male'],
    ['draco', 'Draco: warm, deep, British (male)', 'male'],
    ['hyperion', 'Hyperion: warm, Australian (male)', 'male'],
    ['zeus', 'Zeus: deep, smooth (male)', 'male']
];
const DEFAULT_CLOUD_VOICE = 'aurora';
const VOICE_CACHE = 'learn-lines-voices';
const KNOWN_STREAK = 3; // correct in a row, without hints, for a line to count as known

const synth = window.speechSynthesis;
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const player = new Audio();

let productions = JSON.parse(localStorage.getItem('offBookData')) || [];
let current = null;       // the open show
let voices = [];          // device voices
let bestDeviceVoice = null;

// Practice session
let practiceLines = [];
let practiceIndex = 0;
let sessionMode = 'order';      // 'order', 'shuffle' or 'tricky'
let sessionStart = null;        // how the session began, for Go again
let sessionResults = new Map(); // line -> got it right (last grade this session)
let card = null;                // this card's hints used and grade
let phase = 'cue';              // where the current card is: cue, playing, turn, listening, reveal, result
let autoNextTimer = null;
let micBlocked = false;
let currentUtterance = null;    // token for the cue being spoken; cleared to ignore late callbacks
let recognition = null;
let lastHeard = '';

let editingIndex = null;
let pickState = null;
let sheetChoice = { scene: 'all', how: 'order' };
let installPrompt = null;

// --- Small helpers ---

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').trim().toUpperCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function uid() {
    return [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function syncData() {
    try { localStorage.setItem('offBookData', JSON.stringify(productions)); }
    catch { toast("This device is out of storage space. Delete a show you don't need."); }
}

let toastTimer = null;
function toast(message, ms = 2800) {
    const el = $('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function fileLabel(input, labelId, empty) {
    const files = [...input.files];
    $(labelId).textContent = files.length ? `✓ ${files.map(f => f.name).join(', ')}` : empty;
}

// The passcode for the Worker: needed to import and share, not to open a share link
function getPasscode() { return localStorage.getItem('extractPasscode') || ''; }
function setPasscode(value) {
    if (value) localStorage.setItem('extractPasscode', value);
    else localStorage.removeItem('extractPasscode');
}

// --- Lines and progress ---

// new: never graded; learning: graded but not yet KNOWN_STREAK right in a row; known
function lineStatus(l) {
    if (l.type !== 'line' || !l.stats || !(l.stats.right + l.stats.wrong)) return 'new';
    return l.stats.streak >= KNOWN_STREAK ? 'known' : 'learning';
}

function progressOf(lines) {
    const all = lines.filter(l => l.type === 'line');
    const known = all.filter(l => lineStatus(l) === 'known').length;
    return { total: all.length, known, pct: all.length ? Math.round(100 * known / all.length) : 0 };
}

// Groups a show's lines by scene heading, skipping scenes with none of your lines
function scenesOf(p) {
    const groups = [];
    let group = { name: '', lines: [] };
    p.lines.forEach(l => {
        if (l.type === 'break') { groups.push(group); group = { name: l.text, lines: [] }; }
        else group.lines.push(l);
    });
    groups.push(group);
    return groups.filter(g => g.lines.length).map(g => ({ ...g, name: g.name || 'Opening' }));
}

function sceneOf(line) {
    const lines = current.lines;
    for (let i = lines.indexOf(line); i >= 0; i--) if (lines[i].type === 'break') return lines[i].text;
    return '';
}

// Turns a whole script into the chosen character's cue cards. The cue is whatever
// comes just before each speech; speeches right after each other become one card.
function deriveLines(entries, roles) {
    const mine = new Set(roles.map(norm));
    const lines = [];
    let scene = null, lastMine = -2;
    entries.forEach((e, i) => {
        if (!mine.has(norm(e.speaker))) return;
        if (lastMine === i - 1 && lines.length) {
            lines[lines.length - 1].text += ' ' + e.text;
            lastMine = i;
            return;
        }
        if (e.scene && e.scene !== scene) { lines.push({ type: 'break', text: e.scene }); scene = e.scene; }
        const prev = entries[i - 1];
        const cued = prev && prev.scene === e.scene;
        lines.push({ type: 'line', cue: cued ? prev.text : '', cueBy: cued ? prev.speaker : '', text: e.text, at: i });
        lastMine = i;
    });
    return lines;
}

// Characters in a script, with how many speeches each has, most first
function charactersOf(script) {
    const counts = new Map();
    script.entries.forEach(e => { if (e.speaker) counts.set(norm(e.speaker), (counts.get(norm(e.speaker)) || 0) + 1); });
    const names = new Map();
    (script.characters || []).forEach(c => names.set(norm(c.name), c.name));
    script.entries.forEach(e => { if (e.speaker && !names.has(norm(e.speaker))) names.set(norm(e.speaker), e.speaker); });
    return [...counts.entries()]
        .filter(([key]) => key !== 'OTHERS')
        .map(([key, count]) => ({ name: names.get(key), count }))
        .sort((a, b) => b.count - a.count);
}

// --- Screens ---

function showView(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== id));
    closeSheet();
    stopSpeaking();
    stopListening();
    cancelAutoNext();
    window.scrollTo(0, 0);
}

function showHome() {
    current = null;
    showView('view-home');
    $('show-list').innerHTML = productions.map(p => {
        const s = progressOf(p.lines);
        return `<button class="show-card" onclick="openShow('${p.id}')">
            <strong>${esc(p.title)}</strong>
            <div class="muted">${esc(p.role)} · ${s.total ? `${s.known} of ${plural(s.total, 'line')} off book` : 'no lines yet'}</div>
            <div class="bar" style="margin-top: 10px;"><div style="width: ${s.pct}%"></div></div>
        </button>`;
    }).join('');
    $('home-empty').classList.toggle('hidden', productions.length > 0);
    renderStreak();
    renderInstallBanner();
}

function openShow(id) {
    current = productions.find(p => p.id === id);
    if (current) showShow(); else showHome();
}

function showShow() {
    showView('view-show');
    $('show-title').textContent = current.title;
    $('show-role').textContent = current.role;
    const s = progressOf(current.lines);
    $('show-bar').style.width = `${s.pct}%`;
    $('show-progress-text').innerHTML = !s.total ? ''
        : s.known === s.total ? `<strong>You're off book!</strong> All ${plural(s.total, 'line')} known 🎉`
        : `<strong>${s.pct}% off book</strong> · ${s.known} of ${plural(s.total, 'line')} known`;
    $('practice-btn').classList.toggle('hidden', !s.total);
    $('show-empty').classList.toggle('hidden', s.total > 0);

    const scenes = scenesOf(current);
    $('scenes-section').classList.toggle('hidden', scenes.length < 2);
    $('scene-list').innerHTML = scenes.map((g, i) => {
        const p = progressOf(g.lines);
        return `<button class="scene-row" onclick="openPracticeSheet(${i})">
            <span class="scene-name">${esc(g.name)}</span>
            <span class="bar"><div style="width: ${p.pct}%"></div></span>
            <span class="scene-count ${p.known === p.total ? 'done' : ''}">${p.known === p.total ? '✓ ' : ''}${p.known}/${p.total}</span>
        </button>`;
    }).join('');
    $('share-box').classList.add('hidden');
    prepareVoices();
}

function showAdd() { showView('view-add'); }

// --- New show: typed in or from a spreadsheet ---

let manualFromCsv = false;
function showManual(fromCsv) {
    manualFromCsv = fromCsv;
    showView('view-manual');
    $('manual-csv-field').classList.toggle('hidden', !fromCsv);
    $('manual-status').textContent = '';
}

async function createManual() {
    const title = $('manual-title').value.trim();
    const role = $('manual-role').value.trim();
    const file = $('manual-csv').files[0];
    const status = $('manual-status');
    status.classList.add('error');
    if (!title) return status.textContent = 'Enter the show title.';
    if (!role) return status.textContent = 'Enter your character.';
    if (manualFromCsv && !file) return status.textContent = 'Choose the spreadsheet file.';

    const p = { id: uid(), title, role, lines: [] };
    productions.push(p);
    current = p;
    if (manualFromCsv) {
        const count = importCSVText(await file.text());
        if (!count) {
            productions.pop();
            syncData();
            return status.textContent = "Couldn't find any lines in that file. It needs Cue and Line columns.";
        }
        showShow();
        toast(`Added ${plural(count, 'line')}`);
    } else {
        syncData();
        showEdit();
    }
    ['manual-title', 'manual-role'].forEach(id => $(id).value = '');
}

// --- New show from the script (AI) ---

function showImport() {
    showView('view-import');
    $('import-passcode-field').classList.toggle('hidden', !!getPasscode());
    $('import-status').textContent = '';
    $('import-status').classList.remove('error');
    $('import-progress').classList.add('hidden');
}

function importFilesChanged() {
    const input = $('import-files');
    fileLabel(input, 'import-files-label', '📄 Choose a PDF or photos of the pages');
    const first = input.files[0];
    if (first && !$('import-title').value.trim() && !first.type.startsWith('image/')) {
        $('import-title').value = first.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    }
}

let pdfjsPromise = null;
function loadPdfJs() {
    pdfjsPromise ??= import(PDFJS + 'pdf.min.mjs').then(pdfjs => {
        // Browsers won't start a module worker straight from another origin, so wrap it in a same-origin blob
        const shim = URL.createObjectURL(new Blob([`import "${PDFJS}pdf.worker.min.mjs";`], { type: 'text/javascript' }));
        pdfjs.GlobalWorkerOptions.workerPort = new Worker(shim, { type: 'module' });
        return pdfjs;
    });
    return pdfjsPromise;
}

function canvasToJpeg(canvas) { return canvas.toDataURL('image/jpeg', 0.8); }

async function imageFileToDataUrl(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvasToJpeg(canvas);
}

// Turns the chosen files into pages: text where the PDF has real text, images for scans and photos
async function preparePages(files, status) {
    const pages = [];
    for (const file of files) {
        if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
            const pdfjs = await loadPdfJs();
            const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
            for (let n = 1; n <= doc.numPages; n++) {
                status(`Opening the script: page ${n} of ${doc.numPages}…`);
                const page = await doc.getPage(n);
                const content = await page.getTextContent();
                const text = content.items.map(i => (i.str || '') + (i.hasEOL ? '\n' : '')).join('');
                if (text.replace(/\s/g, '').length > 40) { pages.push({ text: `[Page ${n}]\n${text}` }); continue; }
                const base = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: 1600 / Math.max(base.width, base.height) });
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width; canvas.height = viewport.height;
                await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
                pages.push({ image: canvasToJpeg(canvas) });
            }
        } else if (file.type.startsWith('image/')) {
            status(`Opening ${file.name}…`);
            pages.push({ image: await imageFileToDataUrl(file) });
        } else {
            pages.push({ text: await file.text() });
        }
    }
    return pages;
}

// Groups pages into requests small enough for the Worker and the model's output limit.
// Each section gets the end of the text before it, so its first cue can be found.
function chunkPages(pages) {
    const chunks = [];
    let cur = null;
    for (const p of pages) {
        const kind = p.text !== undefined ? 'text' : 'image';
        const size = (p.text || p.image).length;
        if (!cur || cur.kind !== kind || cur.pages.length >= (kind === 'text' ? 30 : 4) || cur.size + size > (kind === 'text' ? 12000 : 6000000)) {
            cur = { kind, pages: [], size: 0 };
            chunks.push(cur);
        }
        cur.pages.push(p); cur.size += size;
    }
    chunks.forEach((c, i) => { c.context = contextBefore(chunks[i - 1]); });
    return chunks;
}

const contextBefore = chunk => chunk && chunk.kind === 'text' ? chunk.pages.map(p => p.text).join('\n').slice(-1500) : '';

async function workerPost(path, body, passcode = getPasscode()) {
    const res = await fetch(WORKER + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Passcode': passcode },
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = data.code;
        throw err;
    }
    return data;
}

// A section whose answer was cut off is split in half and read again
async function extractChunk(chunk, passcode, warn) {
    let data;
    for (;;) {
        try { data = await workerPost('/extract', { mode: 'script', context: chunk.context, pages: chunk.pages }, passcode); break; }
        catch (e) { if (e.code !== 'rate') throw e; await new Promise(r => setTimeout(r, 10000)); }
    }
    if (!data.truncated) return data;
    if (chunk.pages.length < 2) { warn(); return data; }
    const half = Math.ceil(chunk.pages.length / 2);
    const a = { ...chunk, pages: chunk.pages.slice(0, half) };
    const b = { ...chunk, pages: chunk.pages.slice(half), context: contextBefore(a) };
    const [ra, rb] = [await extractChunk(a, passcode, warn), await extractChunk(b, passcode, warn)];
    return { entries: [...ra.entries, ...rb.entries], characters: [...ra.characters, ...rb.characters] };
}

async function runImport() {
    const statusEl = $('import-status');
    const status = (msg, error = false) => { statusEl.textContent = msg; statusEl.classList.toggle('error', error); };
    const title = $('import-title').value.trim();
    const files = [...$('import-files').files];
    const passcode = getPasscode() || $('import-passcode').value.trim();
    if (!title) return status('Enter the show title.', true);
    if (!files.length) return status('Choose the script.', true);
    if (!passcode) return status('Enter the passcode.', true);

    const btn = $('import-btn');
    btn.disabled = true;
    try {
        const chunks = chunkPages(await preparePages(files, status));
        const results = new Array(chunks.length);
        let next = 0, done = 0, cutOff = false;
        $('import-progress').classList.remove('hidden');
        $('import-bar').style.width = '3%';
        status(chunks.length > 2 ? 'Reading the script… a full play takes a few minutes.' : 'Reading the script…');
        await Promise.all(Array.from({ length: Math.min(5, chunks.length) }, async () => {
            while (next < chunks.length) {
                const i = next++;
                results[i] = await extractChunk(chunks[i], passcode, () => { cutOff = true; });
                done++;
                $('import-bar').style.width = `${Math.max(3, Math.round(100 * done / chunks.length))}%`;
            }
        }));
        setPasscode(passcode);

        // A section that starts mid-scene comes back without a heading; carry the previous one forward
        let scene = '';
        const entries = results.flatMap(r => r.entries).map(e => { scene = e.scene || scene; return { ...e, scene }; });
        const characters = [];
        const seen = new Map();
        results.flatMap(r => r.characters).forEach(c => {
            const known = seen.get(norm(c.name));
            if (!known) { seen.set(norm(c.name), c); characters.push(c); }
            else if (known.gender === 'unknown') known.gender = c.gender;
        });
        if (!entries.some(e => e.speaker)) return status("Couldn't find any lines in that file. Is it the script?", true);
        if (cutOff) toast('Some pages were too dense to read completely. Check your lines.', 5000);
        showPick({ mode: 'import', title, script: { entries, characters } });
    } catch (e) {
        if (e.status === 401) { setPasscode(''); $('import-passcode-field').classList.remove('hidden'); }
        status(e.message || 'Something went wrong. Try again.', true);
    } finally {
        btn.disabled = false;
    }
}

// --- Who do you play? ---

function showPick(state) {
    pickState = state;
    showView('view-pick');
    const chosen = new Set((state.roles || []).map(norm));
    $('pick-intro').innerHTML = state.mode === 'join'
        ? `You're practicing <strong>${esc(state.title)}</strong>. Tap your character.`
        : state.mode === 'change' ? 'Choose the characters you play.'
        : `Found the cast of <strong>${esc(state.title)}</strong>. Tap your character.`;
    $('pick-list').innerHTML = charactersOf(state.script).map(c => `
        <label class="pick-item">
            <input type="checkbox" value="${esc(c.name)}" ${chosen.has(norm(c.name)) ? 'checked' : ''} onchange="updatePick()">
            <span class="pick-name">${esc(c.name)}</span>
            <span class="pick-count">${plural(c.count, 'line')}</span>
        </label>`).join('');
    $('pick-btn').textContent = state.mode === 'change' ? 'Save' : 'Start';
    updatePick();
}

const pickedRoles = () => [...document.querySelectorAll('#pick-list input:checked')].map(i => i.value);
function updatePick() { $('pick-btn').disabled = !pickedRoles().length; }

function pickBack() {
    if (pickState?.mode === 'change') showEdit();
    else if (pickState?.mode === 'import' && !confirm('Go back? The script will need to be read again.')) return;
    else showHome();
}

function confirmPick() {
    const roles = pickedRoles();
    if (!roles.length) return;
    const role = roles.join(' / ');
    if (pickState.mode === 'change') {
        // Keep progress for lines that are the same
        const old = new Map(current.lines.filter(l => l.stats).map(l => [`${l.cue}\n${l.text}`, l.stats]));
        current.lines = deriveLines(current.script.entries, roles);
        current.lines.forEach(l => { const s = old.get(`${l.cue}\n${l.text}`); if (s) l.stats = s; });
        Object.assign(current, { roles, role });
        syncData();
        return showShow();
    }
    const p = { id: uid(), title: pickState.title, role, roles, script: pickState.script, lines: deriveLines(pickState.script.entries, roles) };
    if (pickState.showId) p.showId = pickState.showId;
    productions.push(p);
    current = p;
    syncData();
    showShow();
    toast(`Found ${plural(progressOf(p.lines).total, 'line')} for you. Break a leg!`);
}

// --- Share links ---

// Shows typed in or imported from a spreadsheet have no script, so one is built from the lines
function scriptFromLines(p) {
    const entries = [];
    let scene = '';
    p.lines.forEach(l => {
        if (l.type === 'break') { scene = l.text; return; }
        const prev = entries[entries.length - 1];
        if (l.cue) entries.push({ scene, speaker: 'OTHERS', text: l.cue });
        else if (prev && prev.scene === scene) entries.push({ scene, speaker: 'OTHERS', text: '(pause)' });
        entries.push({ scene, speaker: p.role, text: l.text });
    });
    return { entries, characters: [{ name: p.role, gender: 'unknown' }] };
}

const shareUrl = id => `${location.origin}${location.pathname}#show=${id}`;

async function shareShow() {
    const box = $('share-box');
    box.classList.remove('hidden');
    if (!current.showId) {
        const passcode = getPasscode() || $('share-passcode')?.value.trim();
        if (!passcode) {
            box.innerHTML = `<strong>Share with your cast</strong>
                <p class="muted small">Enter the passcode to create a link for this show.</p>
                <div class="inline-field"><input type="password" id="share-passcode" autocomplete="off"><button class="btn primary" onclick="shareShow()">Share</button></div>`;
            return;
        }
        box.innerHTML = '<p class="muted">Creating a link…</p>';
        try {
            const script = current.script || scriptFromLines(current);
            const { id } = await workerPost('/shows', { title: current.title, ...script }, passcode);
            setPasscode(passcode);
            current.showId = id;
            syncData();
            prepareVoices();
        } catch (e) {
            if (e.status === 401) setPasscode('');
            box.innerHTML = `<p class="status error">${esc(e.status ? e.message : "You're offline. Connect to the internet to share.")}</p>`;
            return;
        }
    }
    const url = shareUrl(current.showId);
    box.innerHTML = `<strong>Share with your cast</strong>
        <p class="muted small">Anyone with this link can pick their character and start practicing, with natural voices and no passcode. It's also how to move this show to another phone or tablet.</p>
        <code>${esc(url)}</code>
        <p class="muted small">Or type this code under <strong>+ Add a show → From a share link</strong>: <strong>${formatCode(current.showId)}</strong></p>
        <div class="row-actions" style="margin-top: 8px;">
            <button class="btn primary" onclick="copyShareLink()">Copy link</button>
            ${navigator.share ? '<button class="btn secondary" onclick="nativeShare()">Send…</button>' : ''}
        </div>`;
}

async function copyShareLink() {
    try { await navigator.clipboard.writeText(shareUrl(current.showId)); toast('Link copied'); }
    catch { toast('Press and hold the link to copy it'); }
}

function nativeShare() {
    navigator.share({ title: current.title, text: `Learn your lines for ${current.title}`, url: shareUrl(current.showId) }).catch(() => {});
}

// Share codes are shown in groups of four for reading aloud or writing down
const formatCode = id => id.match(/.{1,4}/g).join('-');

// Opens a share link (#show=ID) when the app is opened from one
async function handleLink() {
    const match = location.hash.match(/^#show=([A-Za-z0-9]{12})$/);
    if (!match) return false;
    history.replaceState(null, '', location.pathname + location.search);
    await openShowLink(match[1]);
    return true;
}

// A pasted share link, or its code typed in with or without dashes
function parseShowId(text) {
    const match = text.match(/#show=([A-Za-z0-9]{12})/) || text.replace(/[\s-]/g, '').match(/^([A-Za-z0-9]{12})$/);
    return match ? match[1] : null;
}

// Home-screen apps can't be opened by tapping a link (iPhone and iPad always use Safari), so links can be pasted in
function showLinkEntry() {
    showView('view-link');
    $('link-input').value = '';
    $('link-status').textContent = '';
    $('link-status').classList.remove('error');
    $('link-paste-btn').classList.toggle('hidden', !navigator.clipboard?.readText);
}

async function pasteLink() {
    try { $('link-input').value = await navigator.clipboard.readText(); }
    catch { $('link-status').textContent = 'Press and hold the box, then tap Paste.'; return; }
    openLinkInput();
}

function openLinkInput() {
    const id = parseShowId($('link-input').value);
    if (!id) {
        $('link-status').textContent = "That doesn't look like a Learn Lines link or code.";
        $('link-status').classList.add('error');
        return;
    }
    openShowLink(id);
}

// Pick a character, and the show is added
async function openShowLink(id) {
    const existing = productions.find(p => p.showId === id);
    if (existing) { openShow(existing.id); toast('This show is already on your list'); return true; }

    showView('view-join');
    $('join-title').textContent = 'Opening your show…';
    $('join-status').textContent = '';
    $('join-home').classList.add('hidden');
    try {
        const res = await fetch(`${WORKER}/shows/${id}`);
        const show = await res.json();
        if (!res.ok) throw new Error(show.error || "That link didn't work.");
        showPick({ mode: 'join', title: show.title, showId: id, script: { entries: show.entries, characters: show.characters } });
    } catch (e) {
        $('join-title').textContent = "Couldn't open the show";
        $('join-status').textContent = e instanceof TypeError ? "You're offline. Connect to the internet and try again." : e.message;
        $('join-home').classList.remove('hidden');
    }
}

// --- Edit script ---

function showEdit() {
    editingIndex = null;
    showView('view-edit');
    $('change-role-btn').classList.toggle('hidden', !current.script);
    renderLines();
}

function changeCharacter() {
    showPick({ mode: 'change', title: current.title, script: current.script, roles: current.roles || [current.role] });
}

function addLine() {
    const cue = $('line-cue').value.trim();
    const text = $('line-text').value.trim();
    if (!text) return;
    current.lines.push({ type: 'line', cue, text });
    syncData();
    $('line-cue').value = '';
    $('line-text').value = '';
    renderLines();
    toast('Line added');
}

function addSceneBreak() {
    const name = $('scene-name').value.trim();
    if (!name) return;
    current.lines.push({ type: 'break', text: name });
    syncData();
    $('scene-name').value = '';
    renderLines();
}

function renderLines() {
    const list = $('current-lines-list');
    list.innerHTML = current.lines.length ? '' : '<p class="muted">No lines yet. Add your first one above.</p>';
    const container = document.createElement('div');

    current.lines.forEach((l, i) => {
        const item = document.createElement('div');
        item.className = `line-item ${l.type === 'break' ? 'scene-break' : ''}`;
        item.dataset.index = i;

        if (i === editingIndex) {
            item.classList.add('editing');
            const fields = l.type === 'break'
                ? `<label style="margin-top: 0;">Scene heading</label><input type="text" id="edit-scene" value="${esc(l.text)}">`
                : `<label style="margin-top: 0;">The cue</label><textarea id="edit-cue" rows="2">${esc(l.cue)}</textarea>
                   <label>Your line</label><textarea id="edit-text" rows="3">${esc(l.text)}</textarea>`;
            item.innerHTML = `${fields}<div class="edit-actions"><button class="btn primary" onclick="saveEdit(${i})">Save</button><button class="btn secondary" onclick="cancelEdit()">Cancel</button></div>`;
            container.appendChild(item);
            return;
        }

        if (l.type === 'break') {
            item.innerHTML = `<div class="handle">⠿</div><div class="line-content break-text" onclick="editItem(${i})">🎬 ${esc(l.text)}</div><button class="delete-line" onclick="deleteItem(${i})" aria-label="Remove">×</button>`;
        } else {
            item.innerHTML = `<div class="handle">⠿</div><span class="status-dot ${lineStatus(l)}" title="${lineStatus(l)}"></span><div class="line-content" onclick="editItem(${i})"><div class="cue-preview">${esc(l.cue || '(you speak first)')}</div><div>${esc(l.text)}</div></div><button class="delete-line" onclick="deleteItem(${i})" aria-label="Remove">×</button>`;
        }
        item.querySelector('.handle').addEventListener('pointerdown', e => startDrag(e, item, container));
        container.appendChild(item);
    });

    list.appendChild(container);
}

function editItem(index) {
    editingIndex = index;
    renderLines();
    const field = $('edit-text') || $('edit-scene');
    if (field) field.focus();
}

function cancelEdit() { editingIndex = null; renderLines(); }

function saveEdit(index) {
    const l = current.lines[index];
    if (l.type === 'break') {
        const name = $('edit-scene').value.trim();
        if (!name) return;
        l.text = name;
    } else {
        const text = $('edit-text').value.trim();
        if (!text) return;
        l.cue = $('edit-cue').value.trim();
        // A changed line has to be learned again
        if (text !== l.text) delete l.stats;
        l.text = text;
    }
    editingIndex = null;
    syncData(); renderLines();
}

// Pointer events (not HTML5 drag-and-drop) so reordering works with touch as well as a mouse
function startDrag(e, item, container) {
    if (editingIndex !== null) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    item.classList.add('dragging');

    const move = ev => {
        moveBefore(container, item, getDragAfterElement(container, ev.clientY));
        if (ev.clientY < 60) window.scrollBy(0, -12);
        else if (ev.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
    };
    const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        item.classList.remove('dragging');
        saveNewOrder(container);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
}

// Moves the siblings around `item` rather than `item` itself: detaching the
// dragged element from the DOM would release its pointer capture mid-drag.
function moveBefore(container, item, after) {
    if (after === item) return;
    const kids = [...container.children];
    const from = kids.indexOf(item);
    const to = after ? kids.indexOf(after) : kids.length;
    if (to > from) {
        for (let k = from + 1; k < to; k++) container.insertBefore(kids[k], item);
    } else {
        const ref = item.nextSibling;
        for (let k = to; k < from; k++) container.insertBefore(kids[k], ref);
    }
}

function getDragAfterElement(container, y) {
    const elements = [...container.querySelectorAll('.line-item:not(.dragging)')];
    return elements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
        else return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function saveNewOrder(container) {
    const items = [...container.querySelectorAll('.line-item')];
    current.lines = items.map(item => current.lines[item.dataset.index]);
    syncData(); renderLines();
}

function deleteItem(index) {
    if (confirm('Remove this?')) { current.lines.splice(index, 1); editingIndex = null; syncData(); renderLines(); }
}

function resetProgress() {
    if (!confirm('Start over on every line in this show?')) return;
    current.lines.forEach(l => delete l.stats);
    syncData(); renderLines();
    toast('Progress reset');
}

function deleteShow() {
    if (!confirm(`Delete ${current.title}? This can't be undone.`)) return;
    productions = productions.filter(p => p !== current);
    syncData();
    showHome();
}

// --- CSV import / export ---
// Columns: Cue, Line, and optional Scene (the scene heading each line belongs to).

function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') inQuotes = false;
            else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// Appends {scene, cue, line} rows to the open show, adding a scene break
// wherever the scene changes. Returns the number of lines added.
function appendRows(rows) {
    const lines = current.lines;
    let scene = '', count = 0;
    rows.forEach(r => {
        const rowScene = (r.scene || '').trim();
        if (rowScene && rowScene !== scene) { lines.push({ type: 'break', text: rowScene }); scene = rowScene; }
        const cue = (r.cue || '').trim();
        const text = (r.line || '').trim();
        if (text) { lines.push({ type: 'line', cue, text }); count++; }
    });
    syncData();
    return count;
}

function importCSVText(text) {
    const rows = parseCSV(text);
    const header = (rows[0] || []).map(h => h.trim().toLowerCase());
    let col = { cue: header.indexOf('cue'), line: header.findIndex(h => h === 'line' || h === 'your line'), scene: header.indexOf('scene') };
    if (col.cue !== -1 && col.line !== -1) rows.shift();
    else col = { cue: 0, line: 1, scene: 2 };
    return appendRows(rows.map(row => ({ scene: col.scene !== -1 ? row[col.scene] : '', cue: row[col.cue], line: row[col.line] })));
}

function importFromCSV(event) {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    file.text().then(text => {
        const count = importCSVText(text);
        renderLines();
        input.value = '';
        toast(`Imported ${plural(count, 'line')}`);
    });
}

function exportToCSV() {
    const csvField = v => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['Cue', 'Line', 'Scene']];
    let scene = '', sceneHasLines = true;
    current.lines.forEach(l => {
        if (l.type === 'break') {
            if (!sceneHasLines) rows.push(['', '', scene]);
            scene = l.text; sceneHasLines = false;
        } else {
            rows.push([l.cue, l.text, scene]); sceneHasLines = true;
        }
    });
    if (!sceneHasLines) rows.push(['', '', scene]);

    const csv = rows.map(r => r.map(csvField).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${current.title.replace(/[\\/:*?"<>|]/g, '')}.csv`;
    a.click();
}

// --- Sheets ---

function openSheet(id) {
    document.querySelectorAll('.sheet').forEach(s => s.classList.toggle('hidden', s.id !== id));
    $('sheet-backdrop').classList.remove('hidden');
}

function closeSheet() {
    document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden'));
    $('sheet-backdrop').classList.add('hidden');
}

const HOW_HINTS = {
    order: 'Your lines in script order.',
    shuffle: 'Mixed up, so you know every line out of order.',
    tricky: "Just the lines you don't know yet. Misses come back again."
};

function openPracticeSheet(sceneIndex) {
    const scenes = scenesOf(current);
    const saved = current.practice || {};
    const savedScene = scenes.findIndex(g => g.name === saved.scene);
    sheetChoice = {
        scene: sceneIndex !== undefined ? sceneIndex : savedScene >= 0 ? savedScene : 'all',
        how: saved.how || 'order'
    };
    renderPracticeSheet();
    openSheet('sheet-practice');
}

function renderPracticeSheet() {
    const scenes = scenesOf(current);
    const choice = (value, name, lines) => {
        const p = progressOf(lines);
        return `<button class="choice ${sheetChoice.scene === value ? 'selected' : ''}" onclick="sheetChoice.scene = ${value === 'all' ? "'all'" : value}; renderPracticeSheet()">
            <span>${esc(name)}</span><small>${p.known}/${p.total} known</small></button>`;
    };
    $('practice-scenes').innerHTML = choice('all', scenes.length > 1 ? 'All scenes' : 'All my lines', current.lines)
        + (scenes.length > 1 ? scenes.map((g, i) => choice(i, g.name, g.lines)).join('') : '');
    document.querySelectorAll('#practice-how button').forEach(b => b.classList.toggle('selected', b.dataset.how === sheetChoice.how));
    $('how-hint').textContent = HOW_HINTS[sheetChoice.how];
}

function pickHow(how) { sheetChoice.how = how; renderPracticeSheet(); }

function startFromSheet() {
    const scenes = scenesOf(current);
    const group = sheetChoice.scene === 'all' ? null : scenes[sheetChoice.scene];
    current.practice = { scene: group ? group.name : 'all', how: sheetChoice.how };
    syncData();
    startPractice(group ? group.lines : current.lines.filter(l => l.type === 'line'), sheetChoice.how);
}

// --- Practice ---

function startPractice(lines, how) {
    const set = how === 'tricky' ? lines.filter(l => lineStatus(l) !== 'known') : [...lines];
    if (!set.length) { toast(how === 'tricky' ? 'You know all of these already! 🎉' : 'No lines here yet.'); return; }
    beginSession(how === 'shuffle' ? shuffle(set) : set, how, () => startPractice(lines, how));
}

function beginSession(lines, mode, start) {
    practiceLines = [...lines];
    practiceIndex = 0;
    sessionMode = mode;
    sessionStart = start;
    sessionResults = new Map();
    showView('view-practice');
    $('practice-main').classList.remove('hidden');
    $('session-summary').classList.add('hidden');
    showCurrentFlashcard();
}

function practiceMissed() {
    const missed = [...sessionResults].filter(([, got]) => !got).map(([line]) => line);
    beginSession(missed, 'tricky', sessionStart);
}

function restartSession() { sessionStart(); }
function exitPractice() { showShow(); }

const handsFree = () => !!SpeechRec && !micBlocked && localStorage.getItem('handsFree') !== 'false';
function saveHandsFree() { localStorage.setItem('handsFree', $('handsfree-toggle').checked); }

function showCurrentFlashcard() {
    stopSpeaking();
    stopListening();
    cancelAutoNext();
    const line = practiceLines[practiceIndex];
    card = { hints: 0, grade: null, statsBefore: line.stats && { ...line.stats }, requeued: false };

    $('practice-count').textContent = `${practiceIndex + 1} / ${practiceLines.length}`;
    $('practice-bar').style.width = `${Math.round(100 * practiceIndex / practiceLines.length)}%`;
    $('practice-scene').textContent = sceneOf(line);
    $('context').innerHTML = contextFor(line);
    // OTHERS is the stand-in speaker for cues in shows that were typed in rather than imported
    const by = line.cueBy === 'OTHERS' ? undefined : line.cueBy;
    $('cue-by').textContent = line.cue ? (by === '' && line.at !== undefined ? 'Stage direction' : by || 'Cue') : '';
    $('display-cue').textContent = line.cue || 'You speak first.';
    $('hint-text').classList.add('hidden');
    $('heard-text').textContent = '';
    $('line-reveal').classList.add('hidden');
    $('display-line').textContent = line.text;
    $('check-result').textContent = '';
    $('tool-back').disabled = practiceIndex === 0;
    $('hint-btn').innerHTML = '💡<span>Hint</span>';

    if (!line.cue) startTurn();
    else if (handsFree()) playCue();
    else setPhase('cue');
}

// The two speeches before the cue, from the script, so the cue makes sense
function contextFor(line) {
    const entries = current.script?.entries;
    if (!entries || line.at === undefined || !line.cue) return '';
    const cueAt = line.at - 1;
    return entries.slice(Math.max(0, cueAt - 2), cueAt)
        .filter(e => e.scene === entries[cueAt].scene)
        .map(e => `<p>${e.speaker ? `<span class="speaker">${esc(e.speaker)}</span>` : ''}${e.speaker ? esc(e.text) : `<em>${esc(e.text)}</em>`}</p>`)
        .join('');
}

function setPhase(p) {
    phase = p;
    const btn = $('primary-btn');
    btn.classList.remove('listening', 'hidden');
    $('grade-row').classList.add('hidden');
    $('fix-grade').innerHTML = '';
    const canListen = SpeechRec && !micBlocked;
    if (p === 'cue') btn.textContent = '🔊 Hear the cue';
    else if (p === 'playing') btn.textContent = '🔊 Playing… tap to skip';
    else if (p === 'turn') btn.textContent = canListen ? '🎤 Say my line' : '👁 Show my line';
    else if (p === 'listening') { btn.textContent = "⏹ I'm done"; btn.classList.add('listening'); }
    else if (p === 'reveal') { btn.classList.add('hidden'); $('grade-row').classList.remove('hidden'); }
    else if (p === 'result') { btn.textContent = practiceIndex + 1 < practiceLines.length ? 'Next →' : 'Finish'; renderFixGrade(); }
}

function primaryAction() {
    cancelAutoNext();
    if (phase === 'cue') playCue();
    else if (phase === 'playing') { stopSpeaking(); startTurn(); }
    else if (phase === 'turn') { if (SpeechRec && !micBlocked) startListening(); else revealForGrading(); }
    else if (phase === 'listening') { if (recognition) recognition.stop(); }
    else if (phase === 'result') nextLine();
}

function startTurn() {
    setPhase('turn');
    if (handsFree()) startListening();
}

function playCue() {
    const line = practiceLines[practiceIndex];
    if (!line.cue) return startTurn();
    stopListening();
    setPhase('playing');
    speakCue(line.cue, line.cueBy, () => { if (phase === 'playing') startTurn(); });
}

// Plays the cue again without changing where the card is (except before the actor's turn)
function replayCue() {
    cancelAutoNext();
    const line = practiceLines[practiceIndex];
    if (!line.cue) return;
    if (['cue', 'playing', 'turn', 'listening'].includes(phase)) return playCue();
    speakCue(line.cue, line.cueBy, () => {});
}

const firstLetters = word => word.replace(/(\p{L})[\p{L}\p{M}'’]*/gu, '$1');

// Each tap shows a little more: first the first letter of every word, then one more whole word at a time
function showHint() {
    cancelAutoNext();
    if (['reveal', 'result'].includes(phase)) return;
    const words = practiceLines[practiceIndex].text.split(/\s+/).filter(Boolean);
    card.hints++;
    const whole = card.hints - 1;
    if (whole >= words.length) return revealForGrading();
    const el = $('hint-text');
    el.textContent = words.map((w, i) => i < whole ? w : firstLetters(w)).join(' ');
    el.classList.remove('hidden');
    $('hint-btn').innerHTML = '💡<span>More</span>';
}

function showLine() {
    cancelAutoNext();
    if (phase !== 'result') revealForGrading();
}

function revealLine() {
    $('line-reveal').classList.remove('hidden');
    $('hint-text').classList.add('hidden');
}

// Shows the line and asks how it went
function revealForGrading() {
    stopSpeaking();
    stopListening();
    revealLine();
    setPhase('reveal');
}

function renderFixGrade() {
    if (card.grade === false) {
        $('fix-grade').innerHTML = `Heard you wrong? <button class="link" onclick="gradeLine(true)">I got it</button> · <button class="link" onclick="retryLine()">Try again</button>`;
    } else if (card.grade === true) {
        $('fix-grade').innerHTML = `<button class="link" onclick="retryLine()">Try again</button> · <button class="link" onclick="gradeLine(false)">Mark as missed</button>`;
    }
}

function retryLine() {
    cancelAutoNext();
    $('line-reveal').classList.add('hidden');
    $('heard-text').textContent = '';
    $('check-result').textContent = '';
    $('display-line').textContent = practiceLines[practiceIndex].text;
    setPhase('turn');
    if (SpeechRec && !micBlocked) startListening();
}

function sceneAllKnown(scene) {
    const group = scenesOf(current).find(g => g.name === (scene || 'Opening'));
    return !!group && group.lines.every(l => lineStatus(l) === 'known');
}

// Records how the line went. Grading the same card again replaces the earlier grade.
function gradeLine(got, advance = true) {
    cancelAutoNext();
    const line = practiceLines[practiceIndex];
    const scene = sceneOf(line);
    const sceneWasKnown = sceneAllKnown(scene);
    const showWasKnown = progressOf(current.lines).known === progressOf(current.lines).total;

    const s = { right: 0, wrong: 0, streak: 0, ...card.statsBefore };
    if (got) { s.right++; if (!card.hints) s.streak++; }
    else { s.wrong++; s.streak = 0; }
    line.stats = s;
    card.grade = got;
    sessionResults.set(line, got);
    syncData();
    recordPracticeDay();

    // In shuffled sessions a missed line comes back a few cards later
    if (!got && sessionMode !== 'order' && !card.requeued) {
        practiceLines.splice(Math.min(practiceIndex + 4, practiceLines.length), 0, line);
        card.requeued = true;
        $('practice-count').textContent = `${practiceIndex + 1} / ${practiceLines.length}`;
    }

    const all = progressOf(current.lines);
    if (!showWasKnown && all.known === all.total) celebrate(`🎉 You're off book for all of ${current.title}!`);
    else if (!sceneWasKnown && sceneAllKnown(scene)) celebrate(`🎉 ${scene || 'This scene'} is off book!`);

    if (advance) nextLine();
    else setPhase('result');
}

function scheduleAutoNext() {
    cancelAutoNext();
    autoNextTimer = setTimeout(nextLine, 1600);
}

function cancelAutoNext() {
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
}

function nextLine() {
    cancelAutoNext();
    if (practiceIndex + 1 < practiceLines.length) { practiceIndex++; showCurrentFlashcard(); }
    else showSummary();
}

function prevLine() {
    if (practiceIndex > 0) { practiceIndex--; showCurrentFlashcard(); }
}

function showSummary() {
    stopSpeaking();
    stopListening();
    const results = [...sessionResults.values()];
    const got = results.filter(Boolean).length, missed = results.length - got;
    const all = progressOf(current.lines);
    $('summary-emoji').textContent = results.length && !missed ? '🎉' : '💪';
    $('summary-text').innerHTML = results.length
        ? `<p class="big-number">${got}/${results.length}</p><p class="muted">right this time</p><p>${all.known} of ${plural(all.total, 'line')} off book</p>`
        : '<p class="muted">Tip: grade each line so Learn Lines knows which ones you still need to work on.</p>';
    $('summary-missed-btn').classList.toggle('hidden', !missed);
    $('practice-bar').style.width = '100%';
    $('practice-main').classList.add('hidden');
    $('session-summary').classList.remove('hidden');
}

// --- Speech check: listen to the actor and compare against the script ---

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

function normalizeWord(w) {
    w = w.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]/gu, '');
    return NUMBER_WORDS[Number(w)] && /^\d+$/.test(w) ? NUMBER_WORDS[Number(w)] : w;
}

// Hyphens join ("to-night" is one word, "tonight"); dashes separate
const splitWords = s => s.split(/[\s–—]+/).map(normalizeWord).filter(Boolean);

function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    return d[a.length][b.length];
}

// Recognizers often mis-hear a letter or two in longer words, so allow one edit there
const wordsMatch = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && editDistance(a, b) <= 1);

// Aligns heard words to the script (longest common subsequence) and reports,
// for each whitespace-separated word of the script, whether it was said.
function checkLine(expected, heard) {
    const tokens = expected.split(/\s+/).filter(Boolean).map(t => ({ display: t, words: splitWords(t) }));
    const exp = [];
    tokens.forEach((t, ti) => t.words.forEach(w => exp.push({ w, ti })));
    // Transcripts often split a hyphenated word ("well known" for "well-known"): rejoin those pairs
    const joined = new Set(tokens.filter(t => t.display.includes('-')).flatMap(t => t.words));
    const heardWords = heard.split(/[\s\-–—]+/).map(normalizeWord).filter(Boolean);
    const got = [];
    for (let i = 0; i < heardWords.length; i++) {
        if (joined.has(heardWords[i] + heardWords[i + 1])) { got.push(heardWords[i] + heardWords[i + 1]); i++; }
        else got.push(heardWords[i]);
    }

    const n = exp.length, m = got.length;
    const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            L[i][j] = wordsMatch(exp[i].w, got[j]) ? L[i+1][j+1] + 1 : Math.max(L[i+1][j], L[i][j+1]);

    const matched = new Array(n).fill(false);
    for (let i = 0, j = 0; i < n && j < m; ) {
        if (wordsMatch(exp[i].w, got[j]) && L[i][j] === L[i+1][j+1] + 1) { matched[i] = true; i++; j++; }
        else if (L[i+1][j] >= L[i][j+1]) i++;
        else j++;
    }

    const tokenMissed = tokens.map(() => false);
    exp.forEach((e, i) => { if (!matched[i]) tokenMissed[e.ti] = true; });
    const hits = matched.filter(Boolean).length;
    return {
        tokens: tokens.map((t, i) => ({ display: t.display, missed: tokenMissed[i] })),
        total: n,
        hits,
        complete: n > 0 && hits === n
    };
}

function setCheckResult(text, kind) {
    const el = $('check-result');
    el.textContent = text;
    el.className = `check-result ${kind}`;
}

function startListening() {
    if (!SpeechRec || micBlocked) return;
    stopSpeaking();
    stopListening();

    const expected = practiceLines[practiceIndex].text;
    const heardEl = $('heard-text');
    const rec = new SpeechRec();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    lastHeard = '';

    rec.onresult = e => {
        lastHeard = [...e.results].map(r => r[0].transcript).join(' ');
        heardEl.textContent = `“${lastHeard.trim()}”`;
        if (checkLine(expected, lastHeard).complete) rec.stop();
    };
    rec.onerror = e => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            micBlocked = true;
            heardEl.textContent = 'The microphone is blocked, so tap 👁 to check your line yourself. You can allow it in your browser settings.';
        } else if (e.error === 'no-speech') heardEl.textContent = "Didn't hear anything. Tap 🎤 to try again.";
    };
    rec.onend = () => {
        if (recognition !== rec) return;
        recognition = null;
        if (lastHeard.trim()) showCheck(expected, lastHeard);
        else {
            if (heardEl.textContent === 'Listening…') heardEl.textContent = "Didn't hear anything. Tap 🎤 to try again.";
            setPhase('turn');
        }
    };

    recognition = rec;
    setPhase('listening');
    heardEl.textContent = 'Listening…';
    try { rec.start(); }
    catch { recognition = null; setPhase('turn'); heardEl.textContent = "Couldn't start the microphone. Try again."; }
}

function stopListening() {
    if (!recognition) return;
    const rec = recognition;
    recognition = null;
    rec.abort();
}

function showCheck(expected, heard) {
    const result = checkLine(expected, heard);
    $('display-line').innerHTML = result.tokens
        .map(t => t.missed ? `<span class="word-missed">${esc(t.display)}</span>` : esc(t.display)).join(' ');
    const missed = result.total - result.hits;
    if (result.complete) setCheckResult(card.hints ? '👍 Got it, with a hint' : '🎉 Perfect!', 'good');
    else if (result.hits / result.total >= 0.8) setCheckResult(`So close! ${plural(missed, 'word')} missed`, 'miss');
    else setCheckResult(`Keep at it: ${result.hits} of ${result.total} words`, 'miss');
    revealLine();
    gradeLine(result.complete, false);
    if (result.complete && handsFree()) scheduleAutoNext();
}

// --- Voices ---

// Higher is better. Browsers list their best voices under these names.
function voiceQuality(v) {
    if (/premium/i.test(v.name)) return 5;
    if (/enhanced|natural|neural/i.test(v.name)) return 4;
    if (/online/i.test(v.name)) return 3;
    if (/google/i.test(v.name)) return 2;
    return v.localService === false ? 1 : 0;
}

function rankedDeviceVoices() {
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    const ranked = voices.map(v => ({ v, q: voiceQuality(v) }));
    const mine = ranked.filter(x => x.v.lang.toLowerCase().startsWith(lang)).sort((a, b) => b.q - a.q || a.v.name.localeCompare(b.v.name));
    return { mine, others: ranked.filter(x => !mine.includes(x)) };
}

function loadVoices() {
    voices = synth.getVoices();
    const { mine } = rankedDeviceVoices();
    bestDeviceVoice = (mine[0] || { v: voices[0] }).v || null;
}

// Natural voices need the Worker, plus either a share link (the show's lines) or the passcode
const naturalAvailable = () => !!WORKER && !!(current?.showId || getPasscode());

// The saved choice: 'cast' (a voice per character), 'cloud:<voice>', 'device:<name>', or '' for the default
function voicePref() {
    const pref = localStorage.getItem('voicePref');
    if (pref !== null) return pref;
    // Before per-character voices: keep a chosen natural voice, but move device-voice users to the (better) default
    const old = localStorage.getItem('preferredVoice');
    return old && old.startsWith('cloud:') ? old : '';
}

// What reads a cue spoken by `speaker`: { cloud: voiceId } or { device: SpeechSynthesisVoice }
function voiceFor(speaker) {
    let pref = voicePref();
    if (!pref) pref = current?.script ? 'cast' : `cloud:${DEFAULT_CLOUD_VOICE}`;
    if (pref.startsWith('device:')) return { device: voices.find(v => v.name === pref.slice(7)) || bestDeviceVoice };
    if (!naturalAvailable()) return { device: bestDeviceVoice };
    if (pref === 'cast') return { cloud: current?.script ? castVoice(speaker) : DEFAULT_CLOUD_VOICE };
    return { cloud: pref.slice(6) };
}

// Gives each character in the script their own voice, matching gender where the script says
const castCache = new Map();
function castVoice(speaker) {
    if (!speaker) return 'pandora';
    let cast = castCache.get(current.id);
    if (!cast) {
        const pools = { female: [], male: [], unknown: [] };
        CLOUD_VOICES.forEach(([id, , g]) => { if (g !== 'narrator') { pools[g].push(id); pools.unknown.push(id); } });
        const genders = new Map((current.script.characters || []).map(c => [norm(c.name), c.gender]));
        const used = { female: 0, male: 0, unknown: 0 };
        cast = new Map();
        current.script.entries.forEach(e => {
            const key = norm(e.speaker);
            if (!key || cast.has(key)) return;
            const g = genders.get(key) || 'unknown';
            cast.set(key, pools[g][used[g]++ % pools[g].length]);
        });
        castCache.set(current.id, cast);
    }
    return cast.get(norm(speaker)) || DEFAULT_CLOUD_VOICE;
}

function renderVoiceOptions() {
    const { mine, others } = rankedDeviceVoices();
    const option = x => `<option value="device:${esc(x.v.name)}">${esc(x.v.name)}${x.q >= 4 ? ' ★' : ''}</option>`;
    let html = '';
    if (WORKER) {
        html += '<optgroup label="Natural voices (online)">';
        if (current?.script) html += '<option value="cast">A different voice for each character</option>';
        html += CLOUD_VOICES.map(([id, label]) => `<option value="cloud:${id}">${esc(label)}</option>`).join('') + '</optgroup>';
    }
    if (mine.length) html += `<optgroup label="Voices on this device (work offline)">${mine.map(option).join('')}</optgroup>`;
    if (others.length) html += `<optgroup label="Other languages">${others.map(option).join('')}</optgroup>`;
    const select = $('voice-select');
    select.innerHTML = html;

    let value = voicePref() || (current?.script ? 'cast' : `cloud:${DEFAULT_CLOUD_VOICE}`);
    if (value === 'cast' && !current?.script) value = `cloud:${DEFAULT_CLOUD_VOICE}`;
    select.value = value;
    if (select.selectedIndex === -1) select.value = bestDeviceVoice ? `device:${bestDeviceVoice.name}` : '';
}

function saveVoicePreference() {
    localStorage.setItem('voicePref', $('voice-select').value);
    updateVoiceStatus();
    prepareVoices();
}

function updateVoiceStatus(message) {
    const natural = !$('voice-select').value.startsWith('device:');
    const needsPasscode = natural && !naturalAvailable();
    $('voice-passcode-field').classList.toggle('hidden', !needsPasscode);
    $('voice-status').textContent = message
        || (needsPasscode ? "Natural voices need your show's share link or the passcode. Until then, cues use this device's voice." : '');
}

function openSettings() {
    loadVoices();
    renderVoiceOptions();
    $('handsfree-toggle').checked = handsFree();
    $('voice-rate').value = localStorage.getItem('voiceRate') || 1;
    $('voice-passcode').value = getPasscode();
    updateVoiceStatus(voiceJobStatus);
    openSheet('sheet-settings');
}

function stopSpeaking() {
    currentUtterance = null;
    synth.cancel();
    player.onended = null;
    player.pause();
}

// A tiny silent WAV, played on the first tap so iOS allows later programmatic playback
function unlockAudio() {
    const samples = 800, buf = new ArrayBuffer(44 + samples * 2), v = new DataView(buf);
    const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples * 2, true);
    player.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    player.play().catch(() => {});
}

const voiceCacheKey = async (voice, text) => new Request(`https://voice-cache.invalid/${voice}/${await sha256(text)}`);

// Natural-voice audio for a cue: from this device's cache if it's been played or
// downloaded before, otherwise from the Worker (which has its own shared cache).
async function getCloudAudio(voice, text) {
    const key = await voiceCacheKey(voice, text);
    const cache = await caches.open(VOICE_CACHE);
    const hit = await cache.match(key);
    if (hit) return hit.blob();

    const res = await fetch(WORKER + '/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Passcode': getPasscode() },
        body: JSON.stringify({ voice, text, show: current?.showId })
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = data.code;
        throw err;
    }
    const blob = await res.blob();
    await cache.put(key, new Response(blob, { headers: { 'Content-Type': 'audio/mpeg' } }));
    return blob;
}

function voiceError(e) {
    if (e.status === 401) return current?.showId ? 'This cue was changed after the show was shared, so it uses the device voice.' : 'Natural voices need the passcode (⚙️ Settings).';
    if (e.code === 'daily-limit') return "Natural voices have reached today's limit.";
    if (e.status) return e.message;
    return "You're offline, so cues use the device voice.";
}

// Speaks a cue in the voice for its speaker, then calls onEnd. Falls back to the device voice.
async function speakCue(text, speaker, onEnd) {
    stopSpeaking();
    const token = {};
    currentUtterance = token;
    const done = () => { if (currentUtterance === token) { currentUtterance = null; onEnd(); } };
    const rate = Number(localStorage.getItem('voiceRate') || 1);
    const choice = voiceFor(speaker);

    if (choice.cloud) {
        try {
            const blob = await getCloudAudio(choice.cloud, text);
            if (currentUtterance !== token) return;
            if (player.src.startsWith('blob:')) URL.revokeObjectURL(player.src);
            player.src = URL.createObjectURL(blob);
            player.playbackRate = rate;
            player.onended = done;
            await player.play();
            return;
        } catch (e) {
            if (currentUtterance !== token) return;
            if (e.name === 'NotAllowedError') { if (phase === 'playing') setPhase('cue'); return; } // autoplay blocked: wait for a tap
            $('heard-text').textContent = voiceError(e);
        }
    }

    const utterance = new SpeechSynthesisUtterance(text);
    if (choice.device || bestDeviceVoice) utterance.voice = choice.device || bestDeviceVoice;
    utterance.rate = rate;
    utterance.onend = done;
    utterance.onerror = done;
    synth.speak(utterance);
}

// Quietly fetches every cue of the open show in its voice, so practice is instant and works offline
let voiceJobKey = '', voiceJobStatus = '';
const voicesReady = new Set();
function prepareVoices() {
    if (!current || !WORKER || !naturalAvailable() || !navigator.onLine) return;
    const cues = current.lines.filter(l => l.type === 'line' && l.cue);
    const jobs = [...new Map(cues.map(l => { const v = voiceFor(l.cueBy).cloud; return [`${v}\n${l.cue}`, { voice: v, text: l.cue }]; })).values()].filter(j => j.voice);
    if (!jobs.length) return;
    const key = `${current.id}|${voicePref()}|${jobs.length}`;
    if (voicesReady.has(key) || voiceJobKey === key) return;

    const show = current;
    voiceJobKey = key;
    const setStatus = msg => { voiceJobStatus = msg; if (!$('sheet-settings').classList.contains('hidden')) updateVoiceStatus(msg); };
    let next = 0, done = 0, failure = null;
    Promise.all(Array.from({ length: 4 }, async () => {
        while (next < jobs.length && !failure && current === show) {
            const job = jobs[next++];
            try { await getCloudAudio(job.voice, job.text); }
            catch (e) {
                // Brief rate limits just mean waiting; anything else stops for now
                if (e.code === 'rate') { next--; await new Promise(r => setTimeout(r, 10000)); continue; }
                failure = e;
                break;
            }
            done++;
            if (done < jobs.length) setStatus(`Getting voices ready… ${done} of ${jobs.length}`);
        }
    })).then(() => {
        voiceJobKey = '';
        if (failure) setStatus(voiceError(failure));
        else if (done >= jobs.length) { voicesReady.add(key); setStatus('✓ All cues ready, even offline'); }
    });
}

// --- Streaks, celebrations and install ---

const dayKey = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

function recordPracticeDay() {
    const days = JSON.parse(localStorage.getItem('practiceDays') || '[]');
    const today = dayKey(new Date());
    if (!days.includes(today)) localStorage.setItem('practiceDays', JSON.stringify([...days, today].slice(-400)));
}

function streakCount() {
    const days = new Set(JSON.parse(localStorage.getItem('practiceDays') || '[]'));
    const d = new Date();
    if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
}

function renderStreak() {
    const n = streakCount();
    $('streak').classList.toggle('hidden', !n);
    $('streak').textContent = `🔥 ${plural(n, 'day')} in a row`;
}

function celebrate(message) {
    toast(message, 4000);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = $('confetti');
    const ctx = canvas.getContext('2d');
    canvas.width = innerWidth; canvas.height = innerHeight;
    canvas.classList.remove('hidden');
    const colors = ['#f94144', '#f9c74f', '#90be6d', '#43aa8b', '#577590', '#f3722c'];
    const bits = Array.from({ length: 140 }, () => ({
        x: innerWidth / 2 + (Math.random() - 0.5) * 80, y: innerHeight * 0.35,
        vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
        size: 6 + Math.random() * 6, color: colors[Math.floor(Math.random() * colors.length)], spin: Math.random() * 6
    }));
    const start = performance.now();
    (function frame(t) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        bits.forEach(b => {
            b.vy += 0.45; b.x += b.vx; b.y += b.vy; b.vx *= 0.99;
            ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.spin * t / 300);
            ctx.fillStyle = b.color; ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
            ctx.restore();
        });
        if (t - start < 2200) requestAnimationFrame(frame);
        else canvas.classList.add('hidden');
    })(start);
}

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function renderInstallBanner() {
    const el = $('install-banner');
    const show = !isStandalone() && !localStorage.getItem('installDismissed') && (installPrompt || isIOS());
    el.classList.toggle('hidden', !show);
    if (!show) return;
    const close = '<button class="banner-close" onclick="dismissInstall()" aria-label="Close">✕</button>';
    el.innerHTML = installPrompt
        ? `<span>📲</span><div class="banner-body"><strong>Install Learn Lines</strong><br>Open it like an app, even offline.</div><button class="btn primary" onclick="installApp()">Install</button>${close}`
        : `<span>📲</span><div class="banner-body"><strong>Put Learn Lines on your home screen</strong><br>Tap <strong>Share</strong> ⬆︎, then <strong>Add to Home Screen</strong>.${productions.length ? ' Already have shows here? Open each one, tap 🔗 Share with cast and copy the link, then paste it into the home-screen app under + Add a show.' : ''}</div>${close}`;
}

function dismissInstall() { localStorage.setItem('installDismissed', '1'); renderInstallBanner(); }

async function installApp() {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    renderInstallBanner();
}

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; renderInstallBanner(); });

// --- Theme ---

function updateThemeIcon(theme) { $('theme-btn').textContent = theme === 'dark' ? '🌙' : '☀️'; }

function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeIcon(next);
}

// --- Keyboard (laptops): space = main button, arrows = next/back, H = hint, S = show, 1/2 = missed/got ---

document.addEventListener('keydown', e => {
    if ($('view-practice').classList.contains('hidden') || !$('session-summary').classList.contains('hidden')) return;
    if ((e.target instanceof Element && e.target.matches('input, textarea, select')) || !$('sheet-backdrop').classList.contains('hidden')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (phase !== 'reveal') primaryAction(); }
    else if (e.key === 'ArrowRight') nextLine();
    else if (e.key === 'ArrowLeft') prevLine();
    else if (e.key === 'h') showHint();
    else if (e.key === 's') showLine();
    else if (e.key === '1' && ['reveal', 'result'].includes(phase)) gradeLine(false);
    else if (e.key === '2' && ['reveal', 'result'].includes(phase)) gradeLine(true);
});

// --- Start ---

function init() {
    const savedTheme = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);

    productions.forEach(p => { p.id ||= uid(); });
    syncData();
    if (!SpeechRec) document.querySelectorAll('.speech-only').forEach(el => el.classList.add('hidden'));
    if (!WORKER) document.querySelectorAll('.online-only').forEach(el => el.classList.add('hidden'));

    loadVoices();
    if (synth.onvoiceschanged !== undefined) synth.onvoiceschanged = loadVoices;
    // iOS only lets audio play programmatically once the element has played during a tap
    document.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('hashchange', handleLink);

    handleLink().then(opened => { if (!opened) showHome(); });

    // Ask the browser not to evict saved shows when storage runs low
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
}

init();
