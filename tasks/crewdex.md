# CrewDex — Auto-Build Your Crew Rolodex

Goal: a PM goes to crewdex.nolimitjones.com, clicks "Connect Gmail," and watches their own crew database build itself from years of callsheets. Everything runs in their browser — emails never touch our servers. Drag-and-drop PDFs as a secondary input.

Pivot note (2026-06-10): original plan was drag-and-drop only. DJ correctly called out that callsheets live in email, so manual upload kills the magic. Gmail-connect (testing mode, up to 100 hand-added testers) is now the core flow.

## Tasks

- [x] Port callsheet parser from rolodex-engine to browser
- [x] (CHANGED — was "drag-and-drop only") Connect Gmail flow: scan inbox for callsheets in the browser
- [x] Drag-and-drop PDF upload as secondary input
- [x] PDF text extraction (pdf.js) with OCR fallback (tesseract.js)
- [x] Live progress screen ("watch it build") during scan
- [x] Searchable dashboard UI (cards, autocomplete, inline edit)
- [x] Save database in browser (IndexedDB) + survives refresh
- [x] Manually add a contact
- [x] Export / import backup file
- [x] Create Web OAuth client ID in DJ's Google Cloud project + add to config — "CrewDex Web" client in Genesis Engine project, 2026-06-11
- [ ] Add PM test users in Google Cloud console (Audience page) before demos — DJ already on the list from his original setup
- [ ] Test end-to-end with DJ's real Gmail (Google says new keys can take ~5 min to a few hours to activate)
- [x] Test with real callsheet PDF (drag-drop path) — 70 crew extracted from "test callsheet.pdf", survives refresh, no errors
- [x] Deploy to Vercel — live at crewdex.vercel.app, 2026-06-11
- [x] Point crewdex.nolimitjones.com at it — DNS record added by DJ; Vercel security certificate auto-issuing
- [x] Department browse view (tabs + counts, sort by most-jobs/most-recent/A–Z, slim scan strip once DB has people) — chosen over drop-down accordion via mockups, deployed 2026-06-11
- [ ] Tune the "Other" department bucket once real Gmail-scan data shows which job titles aren't being recognized
- [x] Edit + delete buttons on every contact card (delete = two-tap confirm + 7-second Undo; all changes save to browser storage instantly) — deployed 2026-06-11
- [ ] Demo to 3 production managers (validation)
- [ ] If validated: Google verification process to remove 100-user/7-day limits
