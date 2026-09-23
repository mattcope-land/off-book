# Learn Lines Worker

A Cloudflare Worker behind the app's online features: **✨ Import from Script** and the
natural cue voices.

## Natural voices (`POST /speak`)

Reads a cue aloud with Deepgram Aura-2 on Workers AI and returns MP3. Audio is cached in
Workers KV by model + voice + text, so each cue is generated once and then shared by
everyone using that script and voice; only cache misses count toward the rate limit.
The app also keeps its own on-device copy, which makes replays instant and offline.

Workers AI's free allowance (10,000 neurons a day) covers roughly 3,600 characters of new
speech a day. On the Workers Paid plan it's about $0.03 per 1,000 characters beyond that.
The voice list is in `VOICES` here and `CLOUD_VOICES` in `app.js`; keep them in sync.

## Script import (`POST /extract`, `mode: 'script'`)

The app turns the script into page text (or page images for scans and photos) and sends it
here in sections. Images are transcribed to text first; then a Fireworks model returns every
speech `{ scene, speaker, text }` (plus stage directions between speeches) and the characters
with a guessed gender, which the app uses to derive any character's cues and to pick voices.
A section whose answer is cut off comes back `truncated`, and the app splits it and retries.
Without `mode`, it returns one character's lines, for app versions before whole-script import.

## Share links (`POST /shows`, `GET /shows/:id`)

A shared script is stored in the `SHOWS` KV namespace under an unguessable 12-character ID.
Creating one needs the passcode; reading one doesn't (the ID is the secret). `/speak` also
accepts requests without the passcode when the text is a line in the given show, so a cast
member with the link gets natural voices, but the link can't be used to generate anything else.

## Protection

A shared passcode (`X-Passcode` header), per-IP rate limits (20 import/share requests and 300
new voice clips a minute), request size limits, and a CORS allowlist. Also set a monthly
spending limit in the Fireworks dashboard.

## Setup

```sh
cd worker
npm install
npx wrangler login
npx wrangler secret put FIREWORKS_API_KEY   # paste the Fireworks key
npx wrangler secret put PASSCODE            # the passcode people type in the app
npx wrangler deploy
```

Then set `WORKER` at the top of `app.js` to the deployed URL.

To change the passcode, run `secret put PASSCODE` again. To try a different model, change
`MODEL` in `wrangler.toml` and redeploy. It must be a Fireworks serverless model that
accepts images. Keep `REASONING_EFFORT = "none"` if the model supports it:
with thinking on, each request took over a minute instead of a few seconds.

Photos and scanned pages are transcribed to text in a first call, then extracted like
typed text. Doing both in one call missed lines.

## Local development

Create `worker/.dev.vars` (gitignored):

```
FIREWORKS_API_KEY=...
PASSCODE=...
```

Run `npx wrangler dev --port 8787`, serve the site on `http://localhost:8765`, and
temporarily point `WORKER` in `app.js` at `http://localhost:8787`.

To watch live logs from the deployed Worker, use `npx wrangler tail`.
