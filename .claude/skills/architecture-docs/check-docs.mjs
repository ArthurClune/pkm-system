#!/usr/bin/env node
// Checks for an architecture-doc revision. Run from the repo root:
//
//   node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/frontend.md
//
// Three things, none of which a read-through reliably catches:
//
//  1. mermaid   — every ```mermaid block parses under the project's OWN mermaid
//                 (web/node_modules), so a diagram cannot ship broken.
//  2. links     — relative links resolve, and heading anchors exist. Includes
//                 INBOUND anchors from sibling docs: renaming a heading breaks
//                 another doc's deep link with no other symptom.
//  3. names     — the set of `inline-code` identifiers dropped since HEAD. A
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
const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: check-docs.mjs <doc.md> [more.md ...]");
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

// ------------------------------------------------------------------ names ---

const identifiers = (text) => new Set(
  [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((s) => s.length < 60));

function checkNames(file, text) {
  let before;
  try {
    before = execFileSync("git", ["show", `HEAD:${relative(REPO, file)}`],
                          { cwd: REPO, encoding: "utf8" });
  } catch {
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
  await checkMermaid(mermaid, file, text);
  checkLinks(file, text);
  checkInbound(file, text);
  checkNames(file, text);
}
process.exit(failures === 0 ? 0 : 1);
