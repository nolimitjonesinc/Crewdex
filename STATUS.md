# CrewDex — Status
_Auto-updated by Status Brain on every push. Last change: Added Status Brain workflow and script to auto-generate this status file._

**Status:** In progress  
**What it is:** A browser-based crew database that builds itself from callsheet PDFs or Gmail, searchable and exportable, with zero server storage.  
**Stack:** Vanilla JavaScript (HTML/CSS/JS), Google OAuth 2.0 (configured), PDF parsing (pdfjs implied), static site.

## What works right now
- Drag-and-drop PDF callsheet upload → crew extraction (tested: 70+ crew from real callsheet)
- Department filtering on the crew panel
- Smart sorting of crew by department
- Clear all crews button (full database wipe)
- Build Callsheet feature (reverse: crew → callsheet)
- PDF parsing engine (ported from proven rolodex-engine)
- Fully client-side: no server storage of PDFs or crew data

## Recent changes (newest first)
- 2026-07-20 — Added Status Brain workflow and script (this auto-updating status file)
- 2026-07-16 — Added department filter + smart sorting to callsheet crew panel
- 2026-06-22 — Initial commit: CrewDex with Build Callsheet and Clear All features

## Reusable parts (for other projects)
- **Callsheet parsing engine** — extracts crew names, roles, and metadata from PDF callsheets — `engine.js`
- **Status Brain** — auto-generates plain-English project status from commits and code — `status-brain.mjs` + `.github/workflows/status-brain.yml`

## Not done / next
- Gmail scanning requires Google Web OAuth client ID to be added to `config.js` + test users configured in Google Cloud Console
- Gmail feature built but not tested end-to-end
- Deploy to `crewdex.nolimitjones.com` (Vercel) — infrastructure ready, not yet deployed
- No package.json yet (currently pure static site; may need one for build/deploy)
- PDF.js library integration not yet visible in file list (likely external CDN)
