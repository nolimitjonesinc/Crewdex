/**
 * CrewDex Extraction Engine (browser port of rolodex-engine)
 * Parses crew rows out of callsheet text, extracts job metadata,
 * and merges new crew into an existing people database.
 */
(function () {
  'use strict';

  const PH_SRC = '\\(?\\d{3}\\)?[\\s\\-.]?\\d{3}[\\s\\-.]?\\d{4}';
  const EM_SRC = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';
  const TM_RE = /\b\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)\b|\bN\/C\b|\bO\/C\b|\bRTS\b/g;

  const HEADER_TOKENS = new Set([
    'title','name','phone','email','call','wrap','role','agent','production','client',
    'talent','camera','editorial','equipment','vendor','electric','grip','art','sound',
    'vtr','vanities','locations','drivers','crafty','notes','summary','job','info',
    'location','hospital','weather','office','truck','parking','breakfast','general',
    'crew','cast','cells',
  ]);
  const HONORIFICS = new Set(['jr','sr','ii','iii','iv']);

  function hasContact(row) {
    return new RegExp(PH_SRC).test(row) || new RegExp(EM_SRC).test(row);
  }

  function isHeaderRow(text) {
    const lower = text.toLowerCase().trim();
    if (!lower) return true;
    const tokens = lower.split(/\s+/);
    const hits = tokens.filter(t => HEADER_TOKENS.has(t)).length;
    return hits >= 2 && hits / tokens.length >= 0.5;
  }

  function extractNameAndRole(text) {
    const cleaned = text.replace(TM_RE, ' ').replace(/[\|*•·]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return { name: '', role: '' };
    const tokens = cleaned.split(' ');
    const roleTokens = [];
    let nameStart = 0;
    const ORDINAL = /^\d+(?:st|nd|rd|th)$/i;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const clean = tok.replace(/[^A-Za-z]/g, '');
      if (ORDINAL.test(tok) || tok === '/' || tok === '-') { roleTokens.push(tok); nameStart = i + 1; continue; }
      if (!clean) { roleTokens.push(tok); nameStart = i + 1; continue; }
      if (clean === clean.toUpperCase() && !HONORIFICS.has(clean.toLowerCase())) {
        roleTokens.push(tok); nameStart = i + 1;
      } else { break; }
    }
    const role = roleTokens.join(' ').replace(/\s+\/\s+/g, ' / ').trim();
    let name = tokens.slice(nameStart).join(' ').trim();
    name = name.replace(/['']/g, "'").replace(/[^A-Za-z\s'\-]/g, '').replace(/\s+/g, ' ').trim();
    if (isHeaderRow(name) || name.split(' ').length > 4) return { name: '', role: '' };
    return { name, role };
  }

  function findAnchors(row) {
    const anchors = [];
    for (const m of row.matchAll(new RegExp(PH_SRC, 'g'))) {
      anchors.push({ type: 'phone', value: m[0], start: m.index, end: m.index + m[0].length });
    }
    for (const m of row.matchAll(new RegExp(EM_SRC, 'g'))) {
      anchors.push({ type: 'email', value: m[0], start: m.index, end: m.index + m[0].length });
    }
    return anchors.sort((a, b) => a.start - b.start);
  }

  function groupAnchors(anchors) {
    const groups = [];
    for (const anchor of anchors) {
      const last = groups[groups.length - 1];
      if (!last) { groups.push([anchor]); continue; }
      const prev = last[last.length - 1];
      if (anchor.start - prev.end <= 40 && !last.some(a => a.type === anchor.type)) last.push(anchor);
      else groups.push([anchor]);
    }
    return groups;
  }

  function parseRow(row) {
    const anchors = findAnchors(row);
    if (anchors.length === 0) return [];
    const groups = groupAnchors(anchors);
    const results = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const segStart = i === 0 ? 0 : groups[i - 1][groups[i - 1].length - 1].end;
      const seg = row.slice(segStart, group[group.length - 1].end);
      const phone = group.find(a => a.type === 'phone')?.value;
      const email = group.find(a => a.type === 'email')?.value;
      const beforeAnchor = seg.slice(0, group[0].start - segStart);
      const { name, role } = extractNameAndRole(beforeAnchor);
      if (name && name.length >= 3) {
        results.push({
          title: role || null,
          name,
          phone: phone ? normalizePhone(phone) : null,
          email: email ? email.toLowerCase() : null,
          callTime: null,
        });
      }
    }
    return results;
  }

  function parseCrewFromText(rawText) {
    const rawRows = rawText.split(/\r?\n/).map(r => r.replace(/\s+/g, ' ').trim()).filter(r => r.length > 0);
    const rows = [];
    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];
      const next = rawRows[i + 1];
      // OCR sometimes splits a name onto its own line above the contact info — stitch those back together.
      if (!hasContact(row) && next && hasContact(next) && row.length < 40 && !isHeaderRow(row)) {
        rows.push(row + ' ' + next);
        i++;
      } else {
        rows.push(row);
      }
    }
    const crew = [];
    for (const row of rows) crew.push(...parseRow(row));
    return dedupeCrewInSheet(crew);
  }

  function normalizePhone(raw) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    if (digits.length === 11 && digits.startsWith('1')) {
      const d = digits.slice(1);
      return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    }
    return raw;
  }

  function dedupeCrewInSheet(crew) {
    const seen = new Map();
    for (const member of crew) {
      const key = member.name.toLowerCase().replace(/\s+/g, ' ');
      if (!seen.has(key)) {
        seen.set(key, member);
      } else {
        const existing = seen.get(key);
        seen.set(key, {
          title: existing.title || member.title,
          name: existing.name,
          phone: existing.phone || member.phone,
          email: existing.email || member.email,
          callTime: existing.callTime || member.callTime,
        });
      }
    }
    return Array.from(seen.values());
  }

  function extractJobMetadata(subjectish) {
    const parts = subjectish.split(/[#\/|]/);
    const production = parts[0]?.trim() || 'Unknown';
    const jobMatch = subjectish.match(/#(\d+-\d+|\d+)/);
    return {
      production: cleanProduction(production),
      jobNumber: jobMatch ? jobMatch[1] : null,
    };
  }

  function cleanProduction(subject) {
    if (!subject) return 'Unknown';
    return subject
      .replace(/\*+PLEASE\s+RESPOND\*+/gi, '')
      .replace(/PLEASE\s+RESPOND\**/gi, '')
      .replace(/UPDATE\s+/gi, '')
      .replace(/NEW\s+CREW\s+/gi, '')
      .replace(/Fwd?:\s*/gi, '')
      .replace(/Re:\s*/gi, '')
      .replace(/\s*[-|//]\s*(Call\s*Sheet|Callsheet|CS\s*&\s*Map|Map\s*&\s*Call|Shoot\s*Day.*|Day\s*\d.*)/gi, '')
      .replace(/\s*#\d+/g, '')
      .replace(/^\s*[\|\-\/\\]+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'Unknown';
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  // Look for a shoot date near the top of the callsheet text (drag-drop files
  // have no email date, so the sheet itself is the best source).
  function findDateInText(text, fallbackYear) {
    const t = text.slice(0, 5000);
    let m = t.match(/\b(0?[1-9]|1[0-2])[\/\-.](0?[1-9]|[12]\d|3[01])[\/\-.](20\d{2}|\d{2})\b/);
    if (m) {
      const y = m[3].length === 2 ? '20' + m[3] : m[3];
      return `${y}-${pad2(m[1])}-${pad2(m[2])}`;
    }
    m = t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?/i);
    if (m) {
      const y = m[3] || String(fallbackYear);
      return `${y}-${pad2(MONTHS[m[1].toLowerCase().slice(0, 3)])}-${pad2(m[2])}`;
    }
    return null;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  /**
   * Parse one callsheet and tag every crew member with its job info.
   * `source` is { subjectish, dateIso?, fallbackYear? } — subjectish is the
   * email subject (Gmail path) or the cleaned filename (drag-drop path).
   */
  function processCallsheet(text, source) {
    const job = extractJobMetadata(source.subjectish || '');
    const date = source.dateIso ||
      findDateInText(text, source.fallbackYear || new Date().getFullYear());
    const crew = parseCrewFromText(text).map(member => ({
      ...member,
      jobNumber: job.jobNumber,
      production: job.production,
      date: date || null,
    }));
    return { job: { ...job, date: date || null }, crew };
  }

  /**
   * Merge freshly-parsed crew into an existing people array. Same rules as
   * the original dedupeGlobal: match by normalized name, keep first
   * phone/email seen, dedupe jobs by production+date.
   */
  function mergeIntoPeople(existingPeople, newCrewWithJobs) {
    const byName = new Map();
    for (const person of existingPeople) {
      byName.set(person.name.toLowerCase().replace(/\s+/g, ' '), {
        ...person,
        jobs: [...(person.jobs || [])],
      });
    }
    let added = 0;
    for (const member of newCrewWithJobs) {
      const nameKey = member.name.toLowerCase().replace(/\s+/g, ' ');
      const job = {
        jobNumber: member.jobNumber || null,
        production: member.production || 'Unknown',
        date: member.date || null,
        title: member.title || null,
        callTime: member.callTime || null,
      };
      if (!byName.has(nameKey)) {
        byName.set(nameKey, {
          name: member.name,
          phone: member.phone || null,
          email: member.email || null,
          jobs: [job],
        });
        added++;
      } else {
        const existing = byName.get(nameKey);
        if (!existing.phone && member.phone) existing.phone = member.phone;
        if (!existing.email && member.email) existing.email = member.email;
        const jobKey = `${job.production}|${job.date}`;
        if (!existing.jobs.some(j => `${j.production}|${j.date}` === jobKey)) existing.jobs.push(job);
      }
    }
    const people = Array.from(byName.values())
      .map(person => ({
        ...person,
        jobs: person.jobs.sort((a, b) => new Date(b.date) - new Date(a.date)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { people, added };
  }

  window.CrewEngine = {
    parseCrewFromText,
    extractJobMetadata,
    processCallsheet,
    mergeIntoPeople,
    normalizePhone,
    findDateInText,
  };
})();
