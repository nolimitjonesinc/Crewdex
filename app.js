/* CrewDex app: Gmail scan + PDF drop intake, searchable rolodex, browser storage.
   All dynamic rendering uses DOM builders + textContent — no HTML string injection. */
(function () {
'use strict';

const E = window.CrewEngine;
const CFG = window.CREWDEX_CONFIG || {};
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const SEARCH_QUERY = '"call sheet" has:attachment';

// ---------------------------------------------------------------------------
// State + storage (IndexedDB key/value)
// ---------------------------------------------------------------------------
let people = [];            // [{name, phone, email, jobs:[…]}]
let scannedIds = new Set(); // gmail message ids already processed
let sheetsScanned = 0;
let cancelScan = false;
let dirtySinceSave = 0;

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('crewdex', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction('kv').objectStore('kv').get(key);
    t.onsuccess = () => res(t.result);
    t.onerror = () => rej(t.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(val, key);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

async function loadDb() {
  try {
    const saved = await idbGet('db');
    if (saved) {
      people = saved.people || [];
      scannedIds = new Set(saved.scannedIds || []);
      sheetsScanned = saved.sheetsScanned || 0;
    }
  } catch (e) {
    toast('Could not load saved data');
  }
  try {
    bkHandle = await idbGet('bkHandle') || null;
    const m = await idbGet('bkMeta') || {};
    bkDirty = !!m.dirty;
    bkLastAt = m.lastAt || null;
  } catch (e) { /* backup meta is best-effort */ }
}
async function saveDb() {
  try {
    await idbSet('db', {
      people: people.map(({ _x, ...rest }) => rest),
      scannedIds: [...scannedIds],
      sheetsScanned,
      savedAt: new Date().toISOString(),
    });
    dirtySinceSave = 0;
    bkDirty = true;
    bkMetaSave();
    scheduleBackup();
    updateBkBar();
  } catch (e) {
    toast('Save failed — export a backup!');
  }
}
function saveSoon() {
  dirtySinceSave++;
  if (dirtySinceSave >= 5) saveDb();
}

// ---------------------------------------------------------------------------
// Backup safety net.
// Chrome/Edge: user picks a backup file once (File System Access API); we
// keep the handle in IndexedDB and silently rewrite that file after changes.
// Other browsers: plain download fallback + reminder banner.
// ---------------------------------------------------------------------------
const FS_OK = 'showSaveFilePicker' in window;
let bkHandle = null;   // FileSystemFileHandle once the user picks a spot
let bkDirty = false;   // data changed since last backup
let bkLastAt = null;
let bkTimer = null;
let bkBarDismissed = false;

function bkMetaSave() {
  idbSet('bkMeta', { dirty: bkDirty, lastAt: bkLastAt }).catch(() => {});
}

function backupPayload() {
  return {
    metadata: {
      app: 'CrewDex',
      exportedAt: new Date().toISOString(),
      uniquePeople: people.length,
      totalAppearances: people.reduce((s, p) => s + (p.jobs?.length || 0), 0),
      sheetsScanned,
    },
    people: people.map(({ _x, ...rest }) => rest),
  };
}

function markBackedUp() {
  bkDirty = false;
  bkLastAt = new Date().toISOString();
  bkMetaSave();
  updateBkBar();
}

async function backupNow(viaGesture) {
  if (!bkHandle) return false;
  try {
    let perm = await bkHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted' && viaGesture) {
      perm = await bkHandle.requestPermission({ mode: 'readwrite' });
    }
    if (perm !== 'granted') { updateBkBar(); return false; }
    const w = await bkHandle.createWritable();
    await w.write(new Blob([JSON.stringify(backupPayload(), null, 2)],
      { type: 'application/json' }));
    await w.close();
    markBackedUp();
    return true;
  } catch (e) {
    updateBkBar();
    return false;
  }
}

function scheduleBackup() {
  if (!bkHandle) return;
  clearTimeout(bkTimer);
  bkTimer = setTimeout(() => backupNow(false), 4000);
}

async function setupAutoBackup() {
  try {
    const h = await window.showSaveFilePicker({
      suggestedName: 'crewdex-backup.json',
      types: [{ description: 'CrewDex backup', accept: { 'application/json': ['.json'] } }],
    });
    bkHandle = h;
    await idbSet('bkHandle', h);
    const ok = await backupNow(true);
    if (ok) toast('Auto-backup on — your rolodex saves itself to ' + h.name + ' ✓');
    return ok;
  } catch (e) {
    return false; // user closed the picker
  }
}

async function smartBackup() {
  if (FS_OK) {
    if (bkHandle && await backupNow(true)) { toast('Backed up ✓'); return; }
    if (await setupAutoBackup()) return;
  }
  exportDb();
}

async function updateBkBar() {
  const bar = document.getElementById('bkbar');
  if (!people.length || bkBarDismissed) { bar.hidden = true; return; }

  if (bkHandle) {
    let perm = 'prompt';
    try { perm = await bkHandle.queryPermission({ mode: 'readwrite' }); } catch (e) {}
    if (perm === 'granted') { bar.hidden = true; return; }
    // Browser restarted and wants a fresh OK before we may touch the file.
    const btn = el('button', 'bk-btn', 'Reconnect');
    btn.addEventListener('click', () => backupNow(true));
    bar.replaceChildren(
      el('span', null, '🔄 Auto-backup needs a quick OK to keep saving your rolodex — '),
      btn);
    bar.hidden = false;
    return;
  }

  if (!bkDirty) { bar.hidden = true; return; }
  const btn = el('button', 'bk-btn', FS_OK ? 'Turn on auto-backup' : 'Download backup');
  btn.addEventListener('click', () => { FS_OK ? setupAutoBackup() : exportDb(); });
  const x = el('button', 'bk-x', '✕');
  x.title = 'Hide for now';
  x.addEventListener('click', () => { bkBarDismissed = true; bar.hidden = true; });
  bar.replaceChildren(
    el('span', null, '⚠️ ' + num(people.length) +
      ' contacts live only in this browser — back them up so a cache-clear can’t take them. '),
    btn, x);
  bar.hidden = false;
}

// ---------------------------------------------------------------------------
// DOM builders (no HTML strings anywhere near user data)
// ---------------------------------------------------------------------------
function el(tag, cls, ...kids) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}
// Text with the matched search term wrapped in <mark>.
function hlNodes(text, q) {
  if (!q) return [text];
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return [text];
  const mark = el('mark', null, text.slice(i, i + q.length));
  return [text.slice(0, i), mark, text.slice(i + q.length)];
}

// ---------------------------------------------------------------------------
// PDF → text (pdf.js, with Tesseract OCR fallback for scanned sheets)
// ---------------------------------------------------------------------------
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let ocrWorker = null;
async function getOcrWorker() {
  if (!ocrWorker) ocrWorker = await Tesseract.createWorker('eng');
  return ocrWorker;
}

async function pdfToText(bytes) {
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Rebuild visual rows: bucket items by y position, sort top→bottom, left→right.
    const rows = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const y = item.transform[5], x = item.transform[4];
      let row = rows.find(r => Math.abs(r.y - y) <= 3);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, str: item.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      lines.push(row.items.sort((a, b) => a.x - b.x).map(i => i.str).join(' '));
    }
  }
  let text = lines.join('\n');

  if (text.replace(/\s/g, '').length < 100) {
    // Image-based PDF — OCR the first few pages.
    const worker = await getOcrWorker();
    const ocrLines = [];
    const maxPages = Math.min(pdf.numPages, 3);
    for (let p = 1; p <= maxPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 1.6 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const result = await worker.recognize(canvas);
      ocrLines.push(result.data.text);
    }
    text = ocrLines.join('\n');
  }
  try { pdf.destroy(); } catch (_) {}
  return text;
}

// ---------------------------------------------------------------------------
// Gmail scan (runs entirely in the browser with the visitor's own token)
// ---------------------------------------------------------------------------
function gmailConnect() {
  if (!CFG.GOOGLE_CLIENT_ID) {
    setNote('Gmail scanning isn’t switched on yet for this copy of CrewDex.');
    return;
  }
  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    callback: (resp) => {
      if (resp && resp.access_token) startGmailScan(resp.access_token);
      else setNote('Gmail connection was cancelled.');
    },
  });
  tokenClient.requestAccessToken();
}

async function gApi(pathAndQuery, token) {
  const res = await fetch(GMAIL_API + pathAndQuery, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('Gmail API ' + res.status);
  return res.json();
}

function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function findPdfParts(payload) {
  const found = [];
  (function walk(parts) {
    if (!parts) return;
    for (const p of parts) {
      if (p.filename && p.filename.toLowerCase().endsWith('.pdf') && p.body?.attachmentId) found.push(p);
      if (p.parts) walk(p.parts);
    }
  })(payload.parts || (payload.body ? [payload] : []));
  return found;
}

async function startGmailScan(token) {
  const limit = parseInt(document.getElementById('scanLimit').value, 10); // 0 = all
  cancelScan = false;
  showProgress('Searching your inbox for callsheets…');

  const ids = [];
  try {
    let pageToken;
    do {
      const r = await gApi(
        `messages?q=${encodeURIComponent(SEARCH_QUERY)}&maxResults=500` +
        (pageToken ? `&pageToken=${pageToken}` : ''), token);
      ids.push(...(r.messages || []).map(m => m.id));
      pageToken = r.nextPageToken;
      progTitle(`Found ${ids.length} callsheet emails so far…`);
    } while (pageToken && !cancelScan && (limit === 0 || ids.length < limit * 3));
  } catch (e) {
    hideProgress();
    toast('Could not search Gmail — try reconnecting');
    return;
  }

  const fresh = ids.filter(id => !scannedIds.has(id));
  const todo = limit === 0 ? fresh : fresh.slice(0, limit);
  const skippedOld = ids.length - fresh.length;
  progTitle(`Reading ${todo.length} callsheets…` +
    (skippedOld ? ` (${skippedOld} already in your rolodex)` : ''));

  let done = 0, found = 0;
  const runOne = async (id) => {
    if (cancelScan) return;
    try {
      const msg = await gApi(`messages/${id}?format=full`, token);
      const headers = msg.payload.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const dateMs = parseInt(msg.internalDate, 10) || Date.now();
      const dateIso = new Date(dateMs).toISOString().slice(0, 10);
      const pdfs = findPdfParts(msg.payload).slice(0, 1);
      scannedIds.add(id);
      if (!pdfs.length) { progLog(`— skipped (no PDF): ${subject.slice(0, 70)}`); return; }
      const att = await gApi(`messages/${id}/attachments/${pdfs[0].body.attachmentId}`, token);
      const text = await pdfToText(b64uToBytes(att.data));
      const result = E.processCallsheet(text, { subjectish: subject, dateIso });
      const merged = E.mergeIntoPeople(people, result.crew);
      people = merged.people;
      found += result.crew.length;
      sheetsScanned++;
      progLog(`✓ ${result.crew.length} crew — ${subject.slice(0, 70)}`);
      saveSoon();
    } catch (e) {
      progLog(`— problem reading one email, moved on`);
    } finally {
      done++;
      progUpdate(done, todo.length, found);
    }
  };

  // Small worker pool so the page stays responsive.
  const queue = [...todo];
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length && !cancelScan) await runOne(queue.shift());
  });
  await Promise.all(workers);

  await saveDb();
  renderStats();
  showPromptOrResults();
  progTitle(cancelScan
    ? 'Stopped — kept everything found so far.'
    : `Done! Your rolodex now has ${people.length.toLocaleString()} people.`);
  setTimeout(hideProgress, cancelScan ? 1500 : 4000);
  toast('Rolodex updated ✓');
}

// ---------------------------------------------------------------------------
// Drag & drop / file picker intake
// ---------------------------------------------------------------------------
async function processFiles(fileList) {
  const files = [...fileList].filter(f => f.name.toLowerCase().endsWith('.pdf'));
  if (!files.length) { toast('Those weren’t PDFs'); return; }
  cancelScan = false;
  showProgress(`Reading ${files.length} callsheet${files.length > 1 ? 's' : ''}…`);
  let done = 0, found = 0;
  for (const file of files) {
    if (cancelScan) break;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = await pdfToText(bytes);
      const base = file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ');
      const result = E.processCallsheet(text, {
        subjectish: base,
        fallbackYear: new Date(file.lastModified || Date.now()).getFullYear(),
      });
      const merged = E.mergeIntoPeople(people, result.crew);
      people = merged.people;
      found += result.crew.length;
      sheetsScanned++;
      progLog(`✓ ${result.crew.length} crew — ${file.name}`);
    } catch (e) {
      progLog(`— couldn’t read ${file.name}`);
    }
    done++;
    progUpdate(done, files.length, found);
  }
  await saveDb();
  renderStats();
  showPromptOrResults();
  progTitle(`Done! Your rolodex now has ${people.length.toLocaleString()} people.`);
  setTimeout(hideProgress, 4000);
  toast('Rolodex updated ✓');
}

// ---------------------------------------------------------------------------
// Progress UI
// ---------------------------------------------------------------------------
function showProgress(title) {
  document.getElementById('progress').hidden = false;
  document.getElementById('progLog').replaceChildren();
  document.getElementById('progFill').style.width = '0%';
  document.getElementById('progStats').replaceChildren();
  progTitle(title);
}
function hideProgress() { document.getElementById('progress').hidden = true; }
function progTitle(t) { document.getElementById('progTitle').textContent = t; }
function progUpdate(done, total, found) {
  document.getElementById('progFill').style.width =
    (total ? Math.round(done / total * 100) : 0) + '%';
  document.getElementById('progStats').replaceChildren(
    el('span', null, `${done} of ${total} callsheets`),
    el('span', null, el('strong', null, people.length.toLocaleString()), ' people in your rolodex'),
    el('span', null, `${found.toLocaleString()} crew listings read`),
  );
  renderStats();
}
function progLog(line) {
  const log = document.getElementById('progLog');
  log.prepend(el('div', null, line));
  while (log.children.length > 60) log.removeChild(log.lastChild);
}

// ---------------------------------------------------------------------------
// Departments (browse view)
// ---------------------------------------------------------------------------
// Order matters: specific departments are checked before generic catch-alls,
// so "ART DIRECTOR" lands in Art (not Production) and "HAIR STYLIST" in
// Hair/Makeup (not Wardrobe). Titles are uppercased, punctuation becomes
// spaces, and the result is space-padded — keywords with spaces are exact
// word matches.
const DEPT_RULES = [
  ['Casting', ['CASTING']],
  ['Hair/Makeup', ['MAKEUP', 'MAKE UP', 'HAIR', 'HMU', 'GROOM']],
  ['Wardrobe', ['WARDROBE', 'COSTUME', 'STYLIST', 'SEAMST', 'TAILOR']],
  ['Art', ['ART DIR', 'ART DEP', 'ART ASS', 'PRODUCTION DESIGN', 'PROP',
    'SET DEC', 'SET DRESS', 'LEADMAN', 'SCENIC', 'GREENS', 'CONSTRUCTION',
    'FOOD STYL']],
  ['Camera', ['CAMERA', ' CAM ', 'DIRECTOR OF PHOTO', 'CINEMATOG', ' DP ',
    ' D P ', 'STEADICAM', ' AC ', ' DIT ', 'DIGITAL TECH', 'DRONE',
    'PHOTOGRAPH', 'VTR', 'VIDEO', 'PLAYBACK', 'FOCUS PULL']],
  ['G&E', ['GAFFER', 'GRIP', 'ELECTRIC', 'BEST BOY', 'LIGHT', 'RIGGING',
    'SWING', 'GENERATOR', 'GENNY', 'DIMMER', 'BOARD OP']],
  ['Sound', ['SOUND', 'MIXER', 'BOOM', 'AUDIO']],
  ['Script', ['SCRIPT', 'TELEPROMPT', 'WRITER']],
  ['Stunts', ['STUNT', 'SAFETY', 'MEDIC']],
  ['Locations', ['LOCATION', 'SITE REP']],
  ['Transport', ['TRANSPO', 'DRIVER', 'TEAMSTER', 'SHUTTLE', 'MOTORHOME',
    'STAKEBED', 'PICTURE CAR']],
  ['Catering', ['CATER', 'CRAFT', 'CHEF', 'COOK']],
  ['Production', ['PRODUC', 'DIRECTOR', ' AD ', ' PA ', 'COORDINATOR',
    ' UPM ', 'MANAGER', 'ASSIST', 'ACCOUNT', 'AGENCY', 'CLIENT', 'EXEC',
    'SUPERVIS', 'SCOUT', 'INTERN', 'RUNNER']],
];
const DEPT_ORDER = ['Production', 'Camera', 'G&E', 'Sound', 'Art', 'Wardrobe',
  'Hair/Makeup', 'Locations', 'Transport', 'Script', 'Stunts', 'Casting',
  'Catering', 'Other'];

let curDept = 'All';
let curSort = 'jobs';

function deptOfTitle(title) {
  if (!title) return 'Other';
  const t = ' ' + String(title).toUpperCase().replace(/[^A-Z0-9&]+/g, ' ').trim() + ' ';
  for (const [dept, keys] of DEPT_RULES) {
    for (const k of keys) if (t.includes(k)) return dept;
  }
  return 'Other';
}

// A person can hold different titles across jobs — majority vote wins.
function personDept(p) {
  let best = 'Other', bestN = 0;
  const tally = {};
  for (const j of p.jobs || []) {
    const d = deptOfTitle(j.title);
    tally[d] = (tally[d] || 0) + 1;
    if (tally[d] > bestN) { bestN = tally[d]; best = d; }
  }
  return best;
}

function lastDate(p) {
  let m = '';
  for (const j of p.jobs || []) if (j.date && j.date > m) m = j.date;
  return m;
}

function renderDepts() {
  const wrap = document.getElementById('depts');
  if (!people.length) {
    wrap.hidden = true;
    document.getElementById('sortrow').hidden = true;
    return;
  }
  const counts = {};
  for (const p of people) {
    const d = personDept(p);
    counts[d] = (counts[d] || 0) + 1;
  }
  const mk = (d, n) => {
    const b = el('button', 'dept' + (d === curDept ? ' active' : ''),
      d + ' ', el('small', null, num(n)));
    b.dataset.dept = d;
    return b;
  };
  const btns = [mk('All', people.length)];
  for (const d of DEPT_ORDER) if (counts[d]) btns.push(mk(d, counts[d]));
  wrap.replaceChildren(...btns);
  wrap.hidden = false;
}

function renderBrowse() {
  renderDepts();
  document.getElementById('sortrow').hidden = false;
  const idxs = [];
  for (let i = 0; i < people.length; i++) {
    if (curDept === 'All' || personDept(people[i]) === curDept) idxs.push(i);
  }
  idxs.sort((a, b) => {
    const pa = people[a], pb = people[b];
    if (curSort === 'az') return pa.name.localeCompare(pb.name);
    if (curSort === 'recent') {
      return lastDate(pb).localeCompare(lastDate(pa)) ||
        (pb.jobs?.length || 0) - (pa.jobs?.length || 0);
    }
    return (pb.jobs?.length || 0) - (pa.jobs?.length || 0) ||
      pa.name.localeCompare(pb.name);
  });
  rbar(curDept + ' — ' + num(idxs.length) +
    (idxs.length === 1 ? ' person' : ' people'), true);
  if (!idxs.length) {
    grid().replaceChildren(el('div', 'empty', el('div', 'ico', '🎬'),
      el('p', null, 'Nobody in this department yet.')));
    return;
  }
  fillGrid(idxs, '');
}

// ---------------------------------------------------------------------------
// Search + cards
// ---------------------------------------------------------------------------
let acIdx = -1;
const qEl = document.getElementById('q');

function bldIdx(p) {
  return [p.name, p.phone, p.email,
    ...(p.jobs || []).map(j => [j.title, j.production, j.jobNumber, j.date].join(' '))]
    .join(' ').toLowerCase();
}
function searchIdx(p) { return p._x || (p._x = bldIdx(p)); }
function clearIdx(p) { delete p._x; }

function onSearch() {
  const q = qEl.value.trim();
  document.getElementById('clrBtn').classList.toggle('show', q.length > 0);
  document.getElementById('sicon').style.display = q ? 'none' : '';
  acIdx = -1;
  if (!q) { closeAc(); showPromptOrResults(); return; }
  document.getElementById('sortrow').hidden = true;
  const ql = q.toLowerCase();
  const hits = [];
  for (let i = 0; i < people.length; i++) {
    if (searchIdx(people[i]).includes(ql)) hits.push(i);
  }
  renderAc(hits.filter(i => people[i].name.toLowerCase().includes(ql)).slice(0, 8), q);
  renderGrid(hits, q);
}

function clearSearch() {
  qEl.value = '';
  document.getElementById('clrBtn').classList.remove('show');
  document.getElementById('sicon').style.display = '';
  closeAc(); showPromptOrResults(); qEl.focus();
}

function promptNode(icon, ...lines) {
  return el('div', 'prompt', el('div', 'ico', icon),
    ...lines.map(l => el('p', null, l)));
}

function showPromptOrResults() {
  document.getElementById('intake').classList.toggle('slim', people.length > 0);
  if (!people.length) {
    renderDepts();
    rbar('', false);
    grid().replaceChildren(promptNode('🎬',
      el('strong', null, 'Your rolodex is empty.'),
      'Scan your Gmail or drop in callsheet PDFs above — your crew database builds itself.'));
  } else if (!qEl.value.trim()) {
    renderBrowse();
  } else {
    onSearch();
  }
}

function onKey(e) {
  const items = document.querySelectorAll('.ac-item');
  if (e.key === 'ArrowDown') { e.preventDefault(); acIdx = Math.min(acIdx + 1, items.length - 1); hilite(items); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); acIdx = Math.max(acIdx - 1, -1); hilite(items); }
  else if (e.key === 'Enter' && acIdx >= 0) { e.preventDefault(); items[acIdx]?.click(); }
  else if (e.key === 'Escape') { closeAc(); }
}
function hilite(items) { items.forEach((n, i) => n.classList.toggle('hi', i === acIdx)); }

function renderAc(idxs, q) {
  const ac = document.getElementById('ac');
  if (!idxs.length) { ac.classList.remove('open'); return; }
  ac.replaceChildren(...idxs.map(i => {
    const p = people[i];
    const meta = (p.jobs?.[0]?.title || '') + (p.jobs?.length ? ' · ' + p.jobs.length + ' jobs' : '');
    const item = el('div', 'ac-item',
      el('span', 'ac-name', hlNodes(p.name, q)),
      el('span', 'ac-meta', meta));
    item.dataset.pick = i;
    return item;
  }));
  ac.classList.add('open');
}
function closeAc() { document.getElementById('ac').classList.remove('open'); }

function renderGrid(idxs, q) {
  rbar(idxs.length === 0 ? 'No results'
    : num(idxs.length) + ' result' + (idxs.length !== 1 ? 's' : '') +
      (idxs.length > 100 ? ' — showing first 100' : ''), idxs.length > 0);
  if (!idxs.length) {
    grid().replaceChildren(el('div', 'empty', el('div', 'ico', '🔍'),
      el('p', null, 'No crew found. Try a different search.')));
    return;
  }
  fillGrid(idxs, q);
}

function fillGrid(idxs, q) {
  const nodes = idxs.slice(0, 100).map(i => cardNode(i, q));
  if (idxs.length > 100) {
    const more = el('div', null, 'Showing 100 of ' + num(idxs.length) + ' — search or pick a smaller department to see more');
    more.style.cssText = 'grid-column:1/-1;text-align:center;padding:16px;font-size:12px;color:var(--muted)';
    nodes.push(more);
  }
  grid().replaceChildren(...nodes);
}

function jobNode(j) {
  const left = el('div', null,
    el('div', 'jtitle', j.title || 'Crew'),
    el('div', 'jprod', j.production || 'Unknown'),
    j.jobNumber ? el('div', 'jnum', 'Job #' + j.jobNumber) : null);
  const right = el('div', null,
    el('div', 'jdate', fmtDate(j.date)),
    j.callTime ? el('div', 'jdate', j.callTime) : null);
  return el('div', 'jitem', left, right);
}

function crowNode(i, type, val) {
  const row = el('div', 'crow', el('span', 'cicon', type === 'tel' ? '📞' : '✉️'));
  row.dataset.ctype = type;
  if (val) {
    const a = el('a', 'clink', val);
    a.href = type === 'tel' ? 'tel:' + val.replace(/\D/g, '') : 'mailto:' + val;
    const edit = el('span', 'cedit', 'edit');
    edit.dataset.edit = i;
    row.append(a, edit);
  } else {
    const add = el('span', 'cempty', '+ Add ' + (type === 'tel' ? 'phone' : 'email'));
    add.dataset.edit = i;
    row.append(add);
  }
  return row;
}

function cardNode(i, q) {
  const p = people[i];
  const role = p.jobs?.[0]?.title || '';
  const jn = p.jobs?.length || 0;

  const name = el('div', 'card-name', hlNodes(p.name, q || ''));
  name.dataset.name = i;
  name.setAttribute('contenteditable', 'false');

  const editBtn = el('button', 'act-btn', '✏️');
  editBtn.dataset.editcard = i;
  editBtn.title = 'Edit name';
  const delBtn = el('button', 'act-btn del', '🗑');
  delBtn.dataset.del = i;
  delBtn.title = 'Delete contact';

  const node = el('div', 'card',
    el('div', 'card-acts', editBtn, delBtn),
    el('div', 'card-hd', name, role ? el('div', 'card-role', role) : null),
    el('div', 'contacts', crowNode(i, 'tel', p.phone), crowNode(i, 'email', p.email)));
  node.dataset.card = i;

  if (jn) {
    const btn = el('button', 'jobs-btn', el('span', 'chev', '▶'),
      ` ${jn} job appearance${jn !== 1 ? 's' : ''}`);
    btn.dataset.jobs = '1';
    node.append(el('div', 'jobs-sect', btn,
      el('div', 'jobs-body', (p.jobs || []).map(jobNode))));
  }
  return node;
}

// --- event delegation for cards / autocomplete -----------------------------
document.addEventListener('click', (e) => {
  const pickEl = e.target.closest('[data-pick]');
  if (pickEl) {
    qEl.value = people[+pickEl.dataset.pick].name;
    closeAc(); onSearch();
    return;
  }
  if (!e.target.closest('#sbox')) closeAc();

  const jobsBtn = e.target.closest('[data-jobs]');
  if (jobsBtn) {
    jobsBtn.classList.toggle('open');
    jobsBtn.nextElementSibling.classList.toggle('open');
    return;
  }
  const delBtn = e.target.closest('[data-del]');
  if (delBtn) {
    if (!delBtn.classList.contains('arm')) {
      // First tap arms the button; it disarms itself after 3 seconds.
      delBtn.classList.add('arm');
      delBtn.textContent = 'Delete?';
      setTimeout(() => {
        delBtn.classList.remove('arm');
        delBtn.textContent = '🗑';
      }, 3000);
    } else {
      deletePerson(+delBtn.dataset.del);
    }
    return;
  }
  const editCardBtn = e.target.closest('[data-editcard]');
  if (editCardBtn) {
    const nameNode = editCardBtn.closest('.card')?.querySelector('[data-name]');
    if (nameNode) nameNode.click();
    return;
  }
  const nameEl = e.target.closest('[data-name]');
  if (nameEl && nameEl.getAttribute('contenteditable') !== 'true') {
    const p = people[+nameEl.dataset.name];
    nameEl.dataset.orig = p.name;
    nameEl.textContent = p.name;
    nameEl.setAttribute('contenteditable', 'true');
    nameEl.focus();
    const r = document.createRange();
    r.selectNodeContents(nameEl); r.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    return;
  }
  const editEl = e.target.closest('[data-edit]');
  if (editEl) startContactEdit(editEl);
});

document.addEventListener('blur', (e) => {
  const n = e.target;
  if (n.dataset && n.dataset.name !== undefined && n.getAttribute('contenteditable') === 'true') {
    n.setAttribute('contenteditable', 'false');
    const p = people[+n.dataset.name];
    const nv = n.textContent.trim();
    if (!nv || nv === p.name) { n.textContent = p.name; return; }
    p.name = nv; clearIdx(p);
    saveDb(); toast('Saved ✓');
  }
}, true);

document.addEventListener('keydown', (e) => {
  const n = e.target;
  if (n.dataset && n.dataset.name !== undefined && n.getAttribute('contenteditable') === 'true') {
    if (e.key === 'Enter') { e.preventDefault(); n.blur(); }
    if (e.key === 'Escape') { n.textContent = n.dataset.orig; n.setAttribute('contenteditable', 'false'); }
  }
});

function rerenderList() {
  renderStats();
  if (qEl.value.trim()) onSearch();
  else showPromptOrResults();
}

function deletePerson(i) {
  const removed = people[i];
  if (!removed) return;
  people.splice(i, 1);
  saveDb();
  rerenderList();
  toastUndo(`Deleted ${removed.name}`, () => {
    people.push(removed);
    saveDb();
    rerenderList();
    toast('Restored ✓');
  });
}

function startContactEdit(trigger) {
  const i = +trigger.dataset.edit;
  const row = trigger.closest('.crow');
  const type = row.dataset.ctype;
  const p = people[i];
  const cur = (type === 'tel' ? p.phone : p.email) || '';
  const inp = document.createElement('input');
  inp.className = 'cinput'; inp.value = cur;
  inp.type = type === 'email' ? 'email' : 'tel';
  inp.placeholder = type === 'tel' ? '(xxx) xxx-xxxx' : 'email@address.com';
  row.replaceChildren(el('span', 'cicon', type === 'tel' ? '📞' : '✉️'), inp);
  inp.focus(); inp.select();
  let finished = false;
  function done() {
    if (finished) return; finished = true;
    const nv = inp.value.trim();
    if (nv !== cur) {
      p[type === 'tel' ? 'phone' : 'email'] = nv || null;
      clearIdx(p); saveDb(); toast('Saved ✓');
    }
    const cardN = row.closest('.card');
    if (cardN) cardN.replaceWith(cardNode(i, ''));
  }
  inp.addEventListener('blur', done);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'Escape') { inp.value = cur; inp.blur(); }
  });
}

// ---------------------------------------------------------------------------
// Add contact / backup / restore
// ---------------------------------------------------------------------------
function addContact() {
  document.getElementById('addForm').reset();
  document.getElementById('addDlg').showModal();
}
document.getElementById('addDlg').addEventListener('close', () => {
  const dlg = document.getElementById('addDlg');
  if (dlg.returnValue !== 'ok') return;
  const name = document.getElementById('adName').value.trim();
  if (!name) return;
  const member = {
    title: document.getElementById('adTitle').value.trim() || null,
    name,
    phone: document.getElementById('adPhone').value.trim() || null,
    email: document.getElementById('adEmail').value.trim().toLowerCase() || null,
    callTime: null,
    production: 'Added by hand',
    jobNumber: null,
    date: new Date().toISOString().slice(0, 10),
  };
  people = E.mergeIntoPeople(people, [member]).people;
  saveDb(); renderStats();
  qEl.value = name; onSearch();
  toast('Contact added ✓');
});

function exportDb() {
  const blob = new Blob([JSON.stringify(backupPayload(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'crewdex-backup.json';
  a.click();
  URL.revokeObjectURL(a.href);
  markBackedUp();
  toast('Backup downloaded ✓');
}

async function importDb(file) {
  try {
    const data = JSON.parse(await file.text());
    const incoming = data.people;
    if (!Array.isArray(incoming)) throw new Error('bad format');
    // Flatten incoming people into crew rows and merge, so an import never wipes anything.
    const rows = [];
    for (const p of incoming) {
      if (!p?.name) continue;
      const jobs = p.jobs?.length ? p.jobs : [{}];
      for (const j of jobs) {
        rows.push({
          title: j.title || null, name: p.name, phone: p.phone || null,
          email: p.email || null, callTime: j.callTime || null,
          production: j.production || 'Imported', jobNumber: j.jobNumber || null,
          date: j.date || null,
        });
      }
    }
    const merged = E.mergeIntoPeople(people, rows);
    people = merged.people;
    await saveDb(); renderStats(); showPromptOrResults();
    toast(`Restored — ${merged.added} new people merged in ✓`);
  } catch (e) {
    toast('That file didn’t look like a CrewDex backup');
  }
}

// ---------------------------------------------------------------------------
// Small helpers + wiring
// ---------------------------------------------------------------------------
function renderStats() {
  set('s-people', num(people.length));
  set('s-jobs', num(people.reduce((s, p) => s + (p.jobs?.length || 0), 0)));
  set('s-sheets', num(sheetsScanned));
  document.getElementById('intake').classList.toggle('slim', people.length > 0);
}
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.classList.remove('act');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
// Toast with an action button (used for "Deleted X — Undo").
function toastUndo(msg, onUndo) {
  const t = document.getElementById('toast');
  const btn = el('button', 'toast-btn', 'Undo');
  let used = false;
  btn.addEventListener('click', () => {
    if (used) return; used = true;
    t.classList.remove('show', 'act');
    onUndo();
  });
  t.replaceChildren(document.createTextNode(msg + ' '), btn);
  t.classList.add('show', 'act');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show', 'act'), 7000);
}
function setNote(msg) { document.getElementById('gmailNote').textContent = msg; }
function set(id, val) { const n = document.getElementById(id); if (n) n.textContent = val; }
function rbar(msg, show) {
  const n = document.getElementById('rbar');
  n.textContent = msg; n.style.display = show ? '' : 'none';
}
function num(n) { return n != null ? Number(n).toLocaleString() : '—'; }
function grid() { return document.getElementById('grid'); }
function fmtDate(s) {
  if (!s) return '';
  try {
    const d = new Date(s);
    if (isNaN(d)) return s;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return s; }
}

document.getElementById('depts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dept]');
  if (!b) return;
  curDept = b.dataset.dept;
  qEl.value = '';
  document.getElementById('clrBtn').classList.remove('show');
  document.getElementById('sicon').style.display = '';
  closeAc();
  renderBrowse();
});
document.getElementById('sortrow').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  curSort = b.dataset.sort;
  document.querySelectorAll('.sbtn').forEach(n => n.classList.toggle('on', n === b));
  renderBrowse();
});

qEl.addEventListener('input', onSearch);
qEl.addEventListener('keydown', onKey);
document.getElementById('clrBtn').addEventListener('click', clearSearch);
document.getElementById('gmailBtn').addEventListener('click', gmailConnect);
document.getElementById('cancelBtn').addEventListener('click', () => { cancelScan = true; });
document.getElementById('addBtn').addEventListener('click', addContact);
document.getElementById('exportBtn').addEventListener('click', smartBackup);
document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', (e) => {
  if (e.target.files[0]) importDb(e.target.files[0]);
  e.target.value = '';
});
document.getElementById('pickBtn').addEventListener('click', () => document.getElementById('pickFile').click());
document.getElementById('pickFile').addEventListener('change', (e) => {
  if (e.target.files.length) processFiles(e.target.files);
  e.target.value = '';
});

const dz = document.getElementById('dropZone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.add('over');
}));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.remove('over');
}));
dz.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) processFiles(e.dataTransfer.files);
});
// Don't let a stray drop anywhere else navigate away from the page.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

if (!CFG.GOOGLE_CLIENT_ID) {
  document.getElementById('gmailBtn').disabled = true;
  setNote('Gmail scanning is coming soon — PDF drop works today.');
}

loadDb().then(() => {
  renderStats();
  showPromptOrResults();
  updateBkBar();
  if (people.length && navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Callsheet Builder
// ---------------------------------------------------------------------------
const CS_DEPTS = [
  'Production', 'Camera', 'G&E', 'Sound', 'Art',
  'Wardrobe', 'Hair/Makeup', 'Locations', 'Transport',
  'Script', 'Stunts', 'Casting', 'Catering', 'Other',
];

// Which people are on this callsheet: { deptName: [personIndex, ...] }
let csSlots = {};
let csMode = false;
let csFilterDept = 'All';   // left-panel department filter
let csSort = 'recent';      // left-panel sort: 'recent' | 'jobs' | 'az'

function openCallsheet() {
  csMode = true;
  document.getElementById('csView').hidden = false;
  document.getElementById('bkbar').hidden = true;
  // Hide rolodex
  ['intake','progress','srch-wrap','depts','sortrow','rbar','grid'].forEach(id => {
    const n = document.getElementById(id);
    if (n) n.style.display = 'none';
  });
  renderCsFilter();
  renderCsRoster('');
  renderCsDepts();
}

function closeCallsheet() {
  csMode = false;
  document.getElementById('csView').hidden = true;
  ['intake','srch-wrap','depts','sortrow','rbar','grid'].forEach(id => {
    const n = document.getElementById(id);
    if (n) n.style.display = '';
  });
  updateBkBar();
  showPromptOrResults();
}

// Left panel: department filter chips (only departments that have people)
function renderCsFilter() {
  const wrap = document.getElementById('csFilter');
  if (!wrap) return;
  const counts = {};
  for (const p of people) {
    const d = personDept(p);
    counts[d] = (counts[d] || 0) + 1;
  }
  // If the active filter no longer has anyone, fall back to All
  if (csFilterDept !== 'All' && !counts[csFilterDept]) csFilterDept = 'All';
  const mk = (d, n) => {
    const b = el('button', 'cs-chip' + (d === csFilterDept ? ' on' : ''),
      d + ' ', el('small', null, num(n)));
    b.dataset.csfilter = d;
    return b;
  };
  const btns = [mk('All', people.length)];
  for (const d of CS_DEPTS) if (counts[d]) btns.push(mk(d, counts[d]));
  wrap.replaceChildren(...btns);
}

// Left panel: searchable, department-filtered, sorted list of crew
function renderCsRoster(q) {
  const ql = q.toLowerCase();
  const list = document.getElementById('csRoster');
  const matches = people.filter((p) => {
    if (csFilterDept !== 'All' && personDept(p) !== csFilterDept) return false;
    if (!q) return true;
    return (p.name + ' ' + (p.jobs?.[0]?.title || '')).toLowerCase().includes(ql);
  });
  matches.sort((a, b) => {
    if (csSort === 'az') return a.name.localeCompare(b.name);
    if (csSort === 'jobs') {
      return (b.jobs?.length || 0) - (a.jobs?.length || 0) || a.name.localeCompare(b.name);
    }
    // recent: newest collaborator first, then alphabetical
    return lastDate(b).localeCompare(lastDate(a)) || a.name.localeCompare(b.name);
  });
  if (!matches.length) {
    list.replaceChildren(el('div', 'cs-empty',
      q ? 'No results' : (csFilterDept === 'All' ? 'Your rolodex is empty' : 'Nobody in this department yet')));
    return;
  }
  list.replaceChildren(...matches.map(p => {
    const idx = people.indexOf(p);
    const role = p.jobs?.[0]?.title || '';
    const dept = personDept(p);
    const inSheet = Object.values(csSlots).some(arr => arr.includes(idx));
    const row = el('div', 'cs-person' + (inSheet ? ' added' : ''),
      el('div', 'cs-person-name', p.name),
      el('div', 'cs-person-meta', role ? role + ' · ' : '', dept));
    row.dataset.csAdd = idx;
    row.title = inSheet ? 'Already on callsheet — click to add again' : 'Click to add to callsheet';
    return row;
  }));
}

// Right panel: the department sections
function renderCsDepts() {
  const wrap = document.getElementById('csDepts');
  wrap.replaceChildren(...CS_DEPTS.map(dept => {
    const slots = (csSlots[dept] || []);
    const sec = el('div', 'cs-sec');
    sec.dataset.csDept = dept;

    const hd = el('div', 'cs-sec-hd',
      el('span', 'cs-sec-name', dept),
      el('span', 'cs-sec-count', slots.length ? String(slots.length) : ''));
    sec.append(hd);

    if (slots.length) {
      const rows = slots.map((pi, si) => {
        const p = people[pi];
        if (!p) return null;
        const role = p.jobs?.[0]?.title || '';
        const rmBtn = el('button', 'cs-rm', '✕');
        rmBtn.dataset.csRm = dept + ':' + si;
        rmBtn.title = 'Remove from callsheet';
        const mvBtn = el('button', 'cs-mv', '⇄');
        mvBtn.dataset.csMv = dept + ':' + si;
        mvBtn.title = 'Move to different department';
        return el('div', 'cs-row',
          el('div', 'cs-row-info',
            el('span', 'cs-row-name', p.name),
            el('span', 'cs-row-role', role)),
          el('div', 'cs-row-phone', p.phone || ''),
          el('div', 'cs-row-acts', mvBtn, rmBtn));
      }).filter(Boolean);
      sec.append(el('div', 'cs-rows', ...rows));
    }

    const drop = el('div', 'cs-drop', '+ Add crew here');
    drop.dataset.csDept = dept;
    sec.append(drop);
    return sec;
  }));
}

function csAddPerson(idx, dept) {
  if (!csSlots[dept]) csSlots[dept] = [];
  csSlots[dept].push(idx);
  renderCsRoster(document.getElementById('csQ').value);
  renderCsDepts();
}

function csRemovePerson(dept, slotIdx) {
  if (!csSlots[dept]) return;
  csSlots[dept].splice(slotIdx, 1);
  renderCsRoster(document.getElementById('csQ').value);
  renderCsDepts();
}

function csMoveDialog(dept, slotIdx) {
  const pi = (csSlots[dept] || [])[slotIdx];
  if (pi == null) return;
  const p = people[pi];
  if (!p) return;
  // Simple prompt: which dept?
  const target = window.prompt(
    'Move "' + p.name + '" to which department?\n\n' +
    CS_DEPTS.map((d, i) => (i + 1) + '. ' + d).join('\n') +
    '\n\nType the number:');
  if (!target) return;
  const n = parseInt(target, 10) - 1;
  const newDept = CS_DEPTS[n];
  if (!newDept || newDept === dept) return;
  csRemovePerson(dept, slotIdx);
  csAddPerson(pi, newDept);
}

// Event delegation for callsheet interactions
document.getElementById('csView').addEventListener('click', (e) => {
  // Department filter chip
  const chipEl = e.target.closest('[data-csfilter]');
  if (chipEl) {
    csFilterDept = chipEl.dataset.csfilter;
    renderCsFilter();
    renderCsRoster(document.getElementById('csQ').value.trim());
    return;
  }
  // Sort toggle
  const sortEl = e.target.closest('[data-cssort]');
  if (sortEl) {
    csSort = sortEl.dataset.cssort;
    document.querySelectorAll('#csSortRow .cs-sbtn').forEach(b =>
      b.classList.toggle('on', b === sortEl));
    renderCsRoster(document.getElementById('csQ').value.trim());
    return;
  }
  const addEl = e.target.closest('[data-cs-add]');
  if (addEl) {
    const idx = +addEl.dataset.csAdd;
    const p = people[idx];
    const dept = personDept(p);
    csAddPerson(idx, dept);
    return;
  }
  const dropEl = e.target.closest('[data-cs-dept]');
  if (dropEl && dropEl.classList.contains('cs-drop')) {
    // "Add crew here" on a specific dept — filter the left panel to that dept
    csFilterDept = dropEl.dataset.csDept || 'All';
    renderCsFilter();
    renderCsRoster(document.getElementById('csQ').value.trim());
    document.getElementById('csQ').focus();
    return;
  }
  const rmEl = e.target.closest('[data-cs-rm]');
  if (rmEl) {
    const [dept, si] = rmEl.dataset.csCRm ? rmEl.dataset.csCRm.split(':') :
      rmEl.dataset.csRm.split(':');
    csRemovePerson(dept, +si);
    return;
  }
  const mvEl = e.target.closest('[data-cs-mv]');
  if (mvEl) {
    const [dept, si] = mvEl.dataset.csMv.split(':');
    csMoveDialog(dept, +si);
    return;
  }
});

document.getElementById('csQ').addEventListener('input', (e) => {
  renderCsRoster(e.target.value.trim());
});

document.getElementById('csBtn').addEventListener('click', openCallsheet);
document.getElementById('csBack').addEventListener('click', closeCallsheet);
document.getElementById('csPrint').addEventListener('click', () => window.print());

// ---------------------------------------------------------------------------
// Clear all contacts
// ---------------------------------------------------------------------------
document.getElementById('clearAllBtn').addEventListener('click', () => {
  if (!people.length) { toast('Nothing to clear'); return; }
  const msg = document.getElementById('clearDlgMsg');
  msg.textContent = 'This removes all ' + num(people.length) + ' contacts from your rolodex and can\'t be undone. Make sure you\'ve downloaded a backup first.';
  document.getElementById('clearDlg').showModal();
});

document.getElementById('clearDlg').addEventListener('close', () => {
  if (document.getElementById('clearDlg').returnValue !== 'ok') return;
  people = [];
  scannedIds = new Set();
  sheetsScanned = 0;
  saveDb();
  renderStats();
  showPromptOrResults();
  toast('All contacts deleted');
});

})();
