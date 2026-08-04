#!/usr/bin/env node
// Checks for an architecture-doc revision. Run from the repo root:
//
//   node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/frontend.md
//
// Four things, none of which a read-through reliably catches:
//
//  1. mermaid   — every ```mermaid block parses under the project's OWN mermaid
//                 (web/node_modules), so a diagram cannot ship broken.
//  2. links     — relative links resolve, and heading anchors exist. Includes
//                 INBOUND anchors from sibling docs: renaming a heading breaks
//                 another doc's deep link with no other symptom.
//  3. sentences — the longest prose sentences, printed for judgement, with any
//                 40+ word sentence THIS EDIT INTRODUCED marked NEW. One idea per
//                 sentence is the aim; no single number is a gate.
//  4. names     — the set of `inline-code` identifiers dropped since HEAD. A
//                 clarity pass is meant to delete sentences, not the
//                 CONSTANT_NAMES and function names agents grep for. Dropped
//                 names are printed for judgement, not failed on: rewording
//                 `foo()` to `foo` shows up here too.
//
// Exits non-zero only for a broken diagram or an unresolved link/anchor.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = normalize(join(dirname(fileURLToPath(import.meta.url)), "../../.."));
const argv = process.argv.slice(2);
const showAll = argv.includes("--all");
const targets = argv.filter((a) => !a.startsWith("--"));
if (targets.length === 0) {
  console.error("usage: check-docs.mjs [--all] <doc.md> [more.md ...]");
  process.exit(2);
}

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

const slugs = (path) => new Set(
  readFileSync(path, "utf8").split("\n")
    .filter((l) => l.startsWith("#"))
    .map((l) => l.replace(/^#+/, "").trim().toLowerCase()
      .replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")));

function checkLinks(file, text) {
  const base = dirname(file);
  for (const [, target, anchor] of text.matchAll(/\]\(([^)#\s]+)(#[^)\s]*)?\)/g)) {
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

function checkInbound(file, text) {
  const mine = slugs(file);
  const name = file.split("/").pop();
  const siblings = execFileSync("git", ["ls-files", "docs", "*.md", "CLAUDE.md"],
                                { cwd: REPO, encoding: "utf8" })
    .split("\n").filter((f) => f && normalize(f) !== normalize(relative(REPO, file)) &&
                               normalize(f) !== normalize(file));
  for (const sib of siblings) {
    const body = readFileSync(join(REPO, sib), "utf8");
    for (const [, anchor] of body.matchAll(
      new RegExp(`${name.replace(/\./g, "\\.")}#([a-z0-9-]+)`, "g"))) {
      if (mine.has(anchor)) ok(`${sib} -> ${name}#${anchor} (inbound)`);
      else fail(`${sib} -> ${name}#${anchor} (inbound anchor no longer exists)`);
    }
  }
}

// ------------------------------------------------------------- sentences ---

// The longest prose sentences, for judgement — not a pass/fail on length. A long
// sentence is sometimes right (a quoted banner string, a list of four names);
// several long ones in a row is the thing to look at. Code blocks, tables and
// headings are excluded; bullets count as their own units.
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

// Longest prose sentences, for judgement — not a pass/fail on length. Sentences
// this edit INTRODUCED are marked, because splitting one sentence often
// lengthens another, and a self-inflicted one can sit past 5th place where a
// fixed top-5 view would never surface it.
function reportSentences(file, text, before) {
  const sentences = sentencesOf(text);
  if (sentences.length === 0) return;
  const wasLong = new Set(
    (before === null ? [] : sentencesOf(before)).filter((s) => s.split(" ").length >= 40));
  const ranked = sentences
    .map((s) => ({ s, n: s.split(" ").length }))
    .map((r) => ({ ...r, isNew: r.n >= 40 && !wasLong.has(r.s) }))
    .sort((a, b) => b.n - a.n);
  const tail = ranked.filter((r) => r.n >= 40);
  const introduced = tail.filter((r) => r.isNew);
  const shown = showAll ? ranked.filter((r) => r.n >= 30) : ranked.slice(0, 5);
  const unshown = introduced.filter((r) => !shown.includes(r));
  console.log(`\n      ${file}: ${tail.length} sentence(s) of ${sentences.length} run 40+ words`
    + `${introduced.length > 0 ? `, ${introduced.length} new since HEAD` : ""}`
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

// ------------------------------------------------------------------ names ---

const identifiers = (text) => new Set(
  [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((s) => s.length < 60));

function checkNames(file, text, before) {
  if (before === null) {
    ok(`${file} names (no HEAD version to compare)`);
    return;
  }
  const dropped = [...identifiers(before)].filter((i) => !identifiers(text).has(i)).sort();
  if (dropped.length === 0) { ok(`${file} names (none dropped since HEAD)`); return; }
  console.log(`note  ${file} dropped ${dropped.length} identifier(s) since HEAD — `
    + `keep the ones that are grep anchors:`);
  for (const d of dropped) console.log(`        ${d}`);
}

// ------------------------------------------------------------------- main ---

const mermaid = await loadMermaid();
for (const file of targets) {
  const text = readFileSync(file, "utf8");
  let before = null;
  try {
    before = execFileSync("git", ["show", `HEAD:${relative(REPO, file)}`],
                          { cwd: REPO, encoding: "utf8" });
  } catch { /* new file, or not tracked: nothing to compare against */ }
  await checkMermaid(mermaid, file, text);
  checkLinks(file, text);
  checkInbound(file, text);
  checkNames(file, text, before);
  reportSentences(file, text, before);
}
process.exit(failures === 0 ? 0 : 1);
