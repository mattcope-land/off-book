# Learn Lines

A web app that helps actors learn their lines: it reads your cues aloud, listens to you say
your line, and tracks which lines you know. Live at [learnlines.net](https://learnlines.net);
the user guide is at [learnlines.net/guide](https://learnlines.net/guide/).

- **Add a show** from the script (PDF or photos, read by AI), a CSV spreadsheet, or by typing.
- **Share a link** with the cast: each person picks their character and gets their own cues.
- **Practice** with natural voices (a different one per character), speech checking,
  hints, and hands-free mode; lines count as known after 3 correct in a row.
- **Installable and offline**: shows and progress live in the browser; there are no accounts.

## How it's built

A static site on GitHub Pages, with no build step:

| File | What it is |
|---|---|
| `index.html` | The screens |
| `styles.css` | Styles (light and dark) |
| `app.js` | Everything else: shows, import, sharing, practice, speech checking, voices |
| `sw.js` | Service worker for offline use (bump `CACHE` when the file list changes) |
| `guide/` | The user guide |
| `worker/` | Cloudflare Worker for script import, share links and natural voices (see its README) |

Saved data lives in `localStorage` under `offBookData` (the app's original name); keep
changes to its shape backward compatible, since people have shows saved in it.

To run locally, serve the folder (e.g. `python3 -m http.server 8765`) and open
http://localhost:8765. The Worker only accepts requests from the origins in
`worker/wrangler.toml`, which include that one.
