#!/usr/bin/env node
/**
 * Status Brain — reads what just changed in a repo and writes a plain-English
 * STATUS.md that reflects the REAL state of the project (not hand-ticked checkboxes).
 *
 * Runs automatically on every push via .github/workflows/status-brain.yml.
 * Command Center reads the STATUS.md this produces; LLMs read it to find reusable parts.
 *
 * Needs one secret: ANTHROPIC_API_KEY (set once in each repo's GitHub secrets).
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const MODEL = "claude-haiku-4-5-20251001"; // cheap — pennies per push
const API_KEY = process.env.ANTHROPIC_API_KEY;
const REPO = process.env.GITHUB_REPOSITORY || "this project";

if (!API_KEY) {
  console.error("No ANTHROPIC_API_KEY set — skipping status update.");
  process.exit(0); // never break a push over this
}

const sh = (cmd) => {
  try { return execSync(cmd, { encoding: "utf8" }).trim(); }
  catch { return ""; }
};
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");

// --- Gather the truth: what changed + what the project is ---------------------
const recentCommits = sh('git log -15 --pretty=format:"%ad | %s" --date=short');
const lastDiffFiles = sh("git diff --name-only HEAD~1 HEAD") || sh("git show --name-only --pretty=format: HEAD");
const fileTree = sh("git ls-files | head -400");
const pkg = read("package.json").slice(0, 2000);
const readme = read("README.md").slice(0, 2500);
const prevStatus = read("STATUS.md"); // so it can update, not rewrite from scratch

// --- Ask the brain to write the status ---------------------------------------
const prompt = `You are the "Status Brain" for a solo founder's app repo: ${REPO}.
You write ONE file, STATUS.md, that captures the REAL current state of this project in plain English a non-coder understands. It must reflect what the CODE actually shows — never invent progress.

Here is the evidence:

RECENT COMMITS (newest first):
${recentCommits || "(none)"}

FILES CHANGED IN THE LATEST PUSH:
${lastDiffFiles || "(unknown)"}

PROJECT FILE LIST (partial):
${fileTree || "(unknown)"}

PACKAGE.JSON (partial):
${pkg || "(none)"}

README (partial):
${readme || "(none)"}

PREVIOUS STATUS.MD (update this — keep what's still true, change what moved):
${prevStatus || "(none yet — first run)"}

Write STATUS.md using EXACTLY this template:

# <Project Name> — Status
_Auto-updated by Status Brain on every push. Last change: <one line about the most recent push>._

**Status:** Live / In progress / Prototype / Stalled  (pick one, judged from the evidence)
**What it is:** one plain-English sentence.
**Stack:** main frameworks/languages.

## What works right now
- bullet list of features that actually exist in the code

## Recent changes (newest first)
- <date> — <plain-English what this push did>
- (keep the last ~8 entries, drop older)

## Reusable parts (for other projects)
- **<tool name>** — what it does — file it lives in
- (only genuinely reusable things; omit if none)

## Not done / next
- honest list of what's clearly unfinished (TODOs, stubs, missing pieces)

Output ONLY the STATUS.md content, nothing else.`;

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": API_KEY,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  }),
});

if (!res.ok) {
  console.error("Anthropic call failed:", res.status, await res.text());
  process.exit(0); // never break a push
}

const data = await res.json();
const statusMd = data.content?.[0]?.text?.trim();
if (!statusMd) { console.error("Empty response — skipping."); process.exit(0); }

writeFileSync("STATUS.md", statusMd + "\n");
console.log("STATUS.md updated.");
