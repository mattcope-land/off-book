# Learn Lines script import Worker

A Cloudflare Worker behind the app's **✨ Import from Script** button. The app turns
the script into page text (or page images for scans and photos) and sends it here in
sections. The Worker asks a Fireworks vision model for the character's lines and returns
`{ lines: [{ scene, cue, line }] }`. The Fireworks key stays in the Worker, so the static
site never sees it.

Protection: a shared passcode (`X-Passcode` header), a per-IP rate limit (20 requests a
minute), request size limits, and a CORS allowlist. Also set a monthly spending limit in
the Fireworks dashboard.

## Setup

```sh
cd worker
npm install
npx wrangler login
npx wrangler secret put FIREWORKS_API_KEY   # paste the Fireworks key
npx wrangler secret put PASSCODE            # the passcode people type in the app
npx wrangler deploy
```

Then set `EXTRACT_API` in `index.html` to the deployed URL plus `/extract`.

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
temporarily point `EXTRACT_API` at `http://localhost:8787/extract`.

To watch live logs from the deployed Worker, use `npx wrangler tail`.
