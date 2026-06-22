# CrewDex

Your crew rolodex, built from your callsheets. Anyone can use it — connect Gmail (coming once the client ID is configured) or drop callsheet PDFs in, and a searchable crew database builds itself. Everything runs in the visitor's browser; no emails or PDFs ever touch a server.

## What's here

- `index.html` / `style.css` / `app.js` — the whole app (static site, no build step)
- `engine.js` — the callsheet parser, ported from the proven rolodex-engine
- `config.js` — put the Google Web OAuth client ID here to switch on Gmail scanning
- `tasks/crewdex.md` — task tracking and project history

## Run it locally

Open the folder with any static file server, e.g.:

```bash
cd crewdex && python3 -m http.server 4243
```

Then visit http://localhost:4243

## Status

Drag-and-drop PDFs works end to end (tested with a real callsheet: 70 crew extracted). Gmail scanning is built but needs a Web OAuth client ID in `config.js` plus test users added in Google Cloud console. Deploy target: crewdex.nolimitjones.com (Vercel).
