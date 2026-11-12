#!/usr/bin/env node
// Checks for an architecture-doc revision. Run from the repo root:
//
//   node .claude/skills/architecture-docs/check-docs.mjs \
//     [--base <ref>] [--all] docs/architecture/frontend.md
//
// Checks none of which a read-through reliably catches:
//
//  1. mermaid   - every ```mermaid block parses under the project's OWN mermaid
//                 (web/node_modules), so a diagram cannot ship broken.
//  2. links     - relative links resolve, heading anchors exist, and so do
//                 same-file `](#anchor)` links.
//     inbound   - every citation `<doc>.md#anchor` in ANY tracked text file
//                 (other docs, code comments, skills, AGENTS.md) resolves,
//                 because renaming a heading breaks a deep link with no other
//                 symptom. Citations in frozen records (specs, plans, beans,
//                 dated documents) are printed as notes: they keep their text.
//  3. sentences - the longest prose sentences, printed for judgement, with any
//                 40+ word sentence THIS EDIT INTRODUCED marked NEW. One idea
//                 per sentence is the aim; no single number is a gate.
//     cells     - the same for table cells, which the sentence pass skips:
//                 a table that has absorbed paragraphs reads as a table and
//                 grows unseen.
//  4. names     - the `inline-code` identifiers dropped since the base. A
//                 clarity pass is meant to delete sentences, not the
//                 CONSTANT_NAMES and function names agents grep for. A name
//                 that now appears in another checked doc prints as "moved
//                 to <file>"; the rest are printed for judgement, not failed
//                 on: rewording `foo()` to `foo` shows up here too.
//  5. size      - each file's word count against the base and, when
//                 .claude/skills/recheck-docs/last-recheck exists, against the
//                 commit on its first line. Facts for judgement, never a gate:
//                 a doc that only ever grows is appending in ship order.
//
// The base is --base <ref>, else the merge-base with main (HEAD when there is
// no main, or on main itself), so a commit on the branch cannot reset the
// comparison.
//
// Exits non-zero only for a broken diagram or an unresolved link/anchor in a
// live file. Bean ids, line numbers and pathless spec pointers in
// docs/architecture are the comment lint's to refuse
// (server/tooling/commentlint).

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = normalize(join(dirname(fileURLToPath(import.meta.url)), "../../.."));
const argv = process.argv.slice(2);
const showAll = argv.includes("--all");
const baseAt = argv.indexOf("--base");
const baseArg = baseAt >= 0 ? argv[baseAt + 1] : undefined;
const targets = argv.filter((a, i) => !a.startsWith("--") && !(baseAt >= 0 && i === baseAt + 1));
if (targets.length === 0 || (baseAt >= 0 && !baseArg)) {
  console.error("usage: check-docs.mjs [--base <ref>] [--all] <doc.md> [more.md ...]");
  process.exit(2);
}

const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 });
const gitOrNull = (...args) => { try { return git(...args); } catch { return null; } };

// A path under these is a frozen record: its citations keep their text.
const FROZEN = [/^docs\/superpowers\//, /^\.beans\//, /(^|\/)\d{4}-\d{2}-\d{2}[^/]*$/];
// Lint test input holding a deliberately broken anchor, not a citation.
const INBOUND_EXCLUDED = new Set(["server/tests/test_commentlint_core.py"]);

const resolveSha = (ref) => gitOrNull("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)?.trim() ?? null;
const baseSha = baseArg !== undefined
  ? resolveSha(baseArg)
  : (gitOrNull("merge-base", "HEAD", "main")?.trim() ?? resolveSha("HEAD"));
if (!baseSha) {
  console.error(`check-docs.mjs: cannot resolve base ${baseArg ?? "HEAD"}`);
  process.exit(2);
}
const baseShort = baseSha.slice(0, 8);
const recheckFile = join(REPO, ".claude/skills/recheck-docs/last-recheck");
const recheckSha = existsSync(recheckFile)
  ? resolveSha(readFileSync(recheckFile, "utf8").split("\n")[0].trim()) : null;
const showAt = (sha, rel) => (sha ? gitOrNull("show", `${sha}:${rel}`) : null);

let failures = 0;
const fail = (msg) => { failures += 1; console.log(`FAIL  ${msg}`); };
const ok = (msg) => console.log(`ok    ${msg}`);

// ---------------------------------------------------------------- mermaid ---

async function loadMermaid() {
  const web = join(REPO, "web/node_modules");
  const { JSDOM } = await import(join(web, "jsdom/lib/api.js"));
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator, configurable: true,
  });
  const { default: mermaid } = await import(join(web, "mermaid/dist/mermaid.core.mjs"));
  mermaid.initialize({ startOnLoad: false });
  return mermaid;
}

async function checkMermaid(mermaid, file, text) {
  const blocks = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return;
  for (const block of blocks) {
    const line = text.slice(0, block.index).split("\n").length;
    const kind = block[1].trim().split("\n")[0];
    try {
      await mermaid.parse(block[1]);
      ok(`${file}:${line} mermaid (${kind})`);
    } catch (e) {
      fail(`${file}:${line} mermaid (${kind})\n      ${e.message.split("\n").join("\n      ")}`);
    }
  }
}

// ------------------------------------------------------------------ links ---

// GitHub's anchors: a repeated heading gets -1, -2 ... after its slug.
function slugsOfText(text) {
  const out = new Set();
  const seen = new Map();
  let fenced = false;
  for (const l of text.split("\n")) {
    if (l.startsWith("```")) fenced = !fenced;
    if (fenced || !/^#{1,6} /.test(l)) continue;
    const slug = l.replace(/^#+/, "").trim().toLowerCase()
      .replace(/[^a-z0-9 _-]/g, "").replace(/ /g, "-");
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    out.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return out;
}
const slugs = (path) => slugsOfText(readFileSync(path, "utf8"));
const blankFences = (text) => text.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "));

function checkLinks(file, text) {
  const base = dirname(file);
  const prose = blankFences(text);
  const mine = slugsOfText(text);
  for (const [, anchor] of prose.matchAll(/\]\(#([^)\s]*)\)/g)) {
    if (mine.has(anchor)) ok(`${file} -> #${anchor}`);
    else fail(`${file} -> #${anchor} (missing anchor in this file)`);
  }
  for (const [, target, anchor] of prose.matchAll(/\]\(([^)#\s]+)(#[^)\s]*)?\)/g)) {
    if (/^[a-z]+:/.test(target)) continue;              // external URL
    const path = normalize(join(base, target));
    if (!existsSync(path)) { fail(`${file} -> ${target} (missing file)`); continue; }
    if (anchor) {
      const a = anchor.slice(1);
      if (!slugs(path).has(a)) { fail(`${file} -> ${target}${anchor} (missing anchor)`); continue; }
    }
    ok(`${file} -> ${target}${anchor ?? ""}`);
  }
}

// Every `<path>.md#anchor` citation in every tracked text file, found once.
let corpus = null;
function citations() {
  if (corpus) return corpus;
  const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
  const names = new Map();
  for (const f of tracked) names.set(f.split("/").pop(), (names.get(f.split("/").pop()) ?? 0) + 1);
  corpus = { tracked, names, cites: [] };
  for (const f of tracked) {
    if (INBOUND_EXCLUDED.has(f) || !existsSync(join(REPO, f))) continue;
    let body;
    try { body = readFileSync(join(REPO, f)); } catch { continue; }
    if (body.subarray(0, 8192).includes(0)) continue;     // binary
    const lines = body.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/([A-Za-z0-9_./-]*[A-Za-z0-9_-]\.md)#([A-Za-z0-9_-]+)/g)) {
        if (/:\/\/[^\s]*$/.test(line.slice(0, m.index + m[1].length))) continue;
        corpus.cites.push({ file: f, line: i + 1, cited: m[1], anchor: m[2] });
      }
    });
  }
  return corpus;
}

// A directory-qualified citation resolves from the citing file or from the
// repo root. A bare name resolves from the citing file's directory, or, from
// code, by basename when no other tracked file shares it: README.md must
// never match deploy/README.md that way.
// An untracked file being checked counts towards its name too, or a new
// contracts/write-path.md would claim every bare `write-path.md#` citation.
function citesTarget(c, rel, names, untracked) {
  if (normalize(join(dirname(c.file), c.cited)) === rel) return true;
  if (c.cited.includes("/")) return normalize(c.cited) === rel;
  const sharers = (names.get(c.cited) ?? 0) + (untracked ? 1 : 0);
  return rel.split("/").pop() === c.cited && sharers === 1;
}

function checkInbound(file, text) {
  const rel = normalize(relative(REPO, resolve(file)));
  const mine = slugsOfText(text);
  const { tracked, names, cites } = citations();
  const untracked = !tracked.includes(rel);
  let live = 0;
  const from = new Set();
  for (const c of cites) {
    if (!citesTarget(c, rel, names, untracked)) continue;
    const where = `${c.file}:${c.line} -> ${c.cited}#${c.anchor}`;
    if (mine.has(c.anchor)) { live += 1; from.add(c.file); continue; }
    if (FROZEN.some((re) => re.test(c.file))) {
      console.log(`note  ${where} (anchor no longer exists; frozen record, left as written)`);
    } else {
      fail(`${where} (inbound anchor no longer exists)`);
    }
  }
  ok(`${file} inbound: ${live} resolving citation(s) from ${from.size} file(s)`);
}

// ------------------------------------------------------------- sentences ---

// The longest prose sentences, for judgement — not a pass/fail on length. A
// long sentence is sometimes right (a quoted banner string, a list of four
// names); several long ones in a row is the thing to look at. Code blocks,
// tables and headings are excluded; bullets count as their own units.
function sentencesOf(text) {
  const prose = text
    .replace(/```[\s\S]*?```/g, "")
    .split("\n").filter((l) => !l.trim().startsWith("|") && !l.startsWith("#"))
    .join("\n")
    .replace(/\n\s*[-*] /g, "\n\n");
  // A following sentence can start lowercase — iPadOS, macOS, jsdom, opQueue —
  // so the lookahead allows any letter, and the abbreviations that would then
  // split wrongly are masked first.
  return prose
    .replace(/\b(e\.g|i\.e|cf|vs|etc|approx)\./gi, "$1\u0001")
    .split(/(?<=[.:])\s+(?=[A-Za-z`*])|\n\n/)
    .map((s) => s.replace(/\u0001/g, ".").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// A row's cells. A pipe inside a code span or escaped as \| is cell text.
function splitRow(row) {
  const cells = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < row.length; i += 1) {
    const c = row[i];
    if (c === "\\" && row[i + 1] === "|") { cell += "|"; i += 1; continue; }
    if (c === "`") inCode = !inCode;
    if (c === "|" && !inCode) { cells.push(cell); cell = ""; continue; }
    cell += c;
  }
  cells.push(cell);
  return cells.slice(1, -1);
}

// Table cells, one unit per cell. Separator rows (|---|:--|) carry no words.
function cellsOf(text) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .split("\n").filter((l) => l.trim().startsWith("|") && !/^\|[\s:|-]+\|?$/.test(l.trim()))
    .flatMap((l) => splitRow(l.trim()))
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Longest units, for judgement — not a pass/fail on length. Units this edit
// INTRODUCED are marked, because splitting one sentence often lengthens
// another, and a self-inflicted one can sit past 5th place where a fixed
// top-5 view would never surface it.
function reportLong(kind, unitsOf, file, text, before) {
  const units = unitsOf(text);
  if (units.length === 0) return;
  const wasLong = new Set(
    (before === null ? [] : unitsOf(before)).filter((s) => s.split(" ").length >= 40));
  const ranked = units
    .map((s) => ({ s, n: s.split(" ").length }))
    .map((r) => ({ ...r, isNew: r.n >= 40 && !wasLong.has(r.s) }))
    .sort((a, b) => b.n - a.n);
  const tail = ranked.filter((r) => r.n >= 40);
  if (kind === "table cell" && tail.length === 0) return;
  const introduced = tail.filter((r) => r.isNew);
  const shown = showAll ? ranked.filter((r) => r.n >= 30) : ranked.slice(0, 5);
  const unshown = introduced.filter((r) => !shown.includes(r));
  console.log(`\n      ${file}: ${tail.length} ${kind}(s) of ${units.length} run 40+ words`
    + `${introduced.length > 0 ? `, ${introduced.length} new since ${baseShort}` : ""}`
    + `${shown.length < tail.length ? `; longest ${shown.length} shown, --all for every 30+` : ""}.`
    + `\n      Read them and decide whether each is one idea:`);
  for (const { s, n, isNew } of shown) {
    console.log(`        ${String(n).padStart(3)}w${isNew ? " NEW" : "   "}  `
      + `${s.slice(0, 92)}${s.length > 92 ? "…" : ""}`);
  }
  for (const { s, n } of unshown) {
    console.log(`        ${String(n).padStart(3)}w NEW  ${s.slice(0, 92)}${s.length > 92 ? "…" : ""}`);
  }
  console.log("");
}

// ------------------------------------------------------------------- size ---

const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

function reportSize(file, text, before, atRecheck) {
  const now = wordCount(text);
  if (before === null && atRecheck === null) { console.log(`size  ${file}: ${now} words (new)`); return; }
  const d = (was) => (was === null ? "(new)" : `${now - wordCount(was) >= 0 ? "+" : ""}${now - wordCount(was)}`);
  const since = [`${d(before)} since ${baseShort}`];
  if (recheckSha) since.push(`${d(atRecheck)} since re-check ${recheckSha.slice(0, 8)}`);
  console.log(`size  ${file}: ${now} words (${since.join(", ")})`);
}

// ------------------------------------------------------------------ names ---

const identifiers = (text) => new Set(
  [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((s) => s.length < 60));

function checkNames(file, text, before, others) {
  if (before === null) {
    ok(`${file} names (no version at ${baseShort} to compare)`);
    return;
  }
  const kept = identifiers(text);
  const dropped = [...identifiers(before)].filter((i) => !kept.has(i)).sort();
  if (dropped.length === 0) { ok(`${file} names (none dropped since ${baseShort})`); return; }
  const where = (name) => others.find((o) => o.names.has(name))?.file;
  console.log(`note  ${file} dropped ${dropped.length} identifier(s) since ${baseShort} - `
    + `keep the ones that are grep anchors:`);
  for (const d of dropped) {
    const to = where(d);
    console.log(`        ${d}${to ? `   (moved to ${to})` : ""}`);
  }
}

// ------------------------------------------------------------------- main ---

const mermaid = await loadMermaid();
console.log(`base  ${baseShort}${baseArg === undefined ? " (merge-base with main)" : ""}`
  + `${recheckSha ? `; re-check ${recheckSha.slice(0, 8)}` : "; no re-check recorded"}`);
const loaded = targets.map((file) => {
  const text = readFileSync(file, "utf8");
  return { file, text, names: identifiers(text) };
});
for (const { file, text } of loaded) {
  const rel = normalize(relative(REPO, resolve(file)));
  const before = showAt(baseSha, rel);
  const atRecheck = showAt(recheckSha, rel);
  await checkMermaid(mermaid, file, text);
  checkLinks(file, text);
  checkInbound(file, text);
  checkNames(file, text, before, loaded.filter((o) => o.file !== file));
  reportLong("sentence", sentencesOf, file, text, before);
  reportLong("table cell", cellsOf, file, text, before);
  reportSize(file, text, before, atRecheck);
}
process.exit(failures === 0 ? 0 : 1);
