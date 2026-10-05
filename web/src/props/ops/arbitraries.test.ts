import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BlockNode } from "../../api/payloads";
import type { BlockOp } from "../../api/ops";
import { applyOps } from "../../outline/tree";
import { sha256Hex } from "../../replica/sha256";
import { subtreeHash } from "../../replica/subtreeHash";
import { findOpTitleViolation } from "../../replica/titles";
import { treeProblems } from "../outline/reading";
import type { NormalBlock, NormalGraph } from "../sync/normalise";
import {
  OPS_PAGES, TITLE_POOL, UID_POOL, exampleArb, rawBatchArb, rawUidMinter, resolveRaw, seedOps,
  startStateArb, type RawDraft, type RawSlot, type StartState,
} from "./arbitraries";

const UID_RE = /^[a-zA-Z0-9_-]{6,32}$/;
const SEED = 20261005;

const allNodes = (nodes: readonly BlockNode[]): BlockNode[] =>
  nodes.flatMap((n) => [n, ...allNodes(n.children)]);

const depth = (nodes: readonly BlockNode[]): number =>
  nodes.length === 0 ? 0 : 1 + Math.max(...nodes.map((n) => depth(n.children)));

const startNodes = (s: StartState): BlockNode[] =>
  OPS_PAGES.flatMap((p) => allNodes(s.pages[p]));

const nb = (uid: string, page: string, parent_uid: string | null, order_idx: number,
            text: string): NormalBlock => ({
  uid, page, parent_uid, order_idx, text, heading: null, collapsed: 0, view_type: null,
  refs: [],
});

// Outline Props: opsb00 > opsb01 > opsb02; Ops Two: opsb03 (2), opsb04 (5) at
// the top; the reset's Proptest page holds pt_seed_1, which no draft may name.
const GRAPH: NormalGraph = {
  pages: ["Ops Two", "Outline Props", "Proptest"],
  blocks: [
    nb("opsb00", "Outline Props", null, 0, "a"),
    nb("opsb01", "Outline Props", "opsb00", 0, "b"),
    nb("opsb02", "Outline Props", "opsb01", 0, "c"),
    nb("opsb03", "Ops Two", null, 2, "d"),
    nb("opsb04", "Ops Two", null, 5, "e"),
    nb("pt_seed_1", "Proptest", null, 0, "seed"),
  ],
};

const resolve = (drafts: RawDraft[]): BlockOp[] => resolveRaw(drafts, GRAPH, rawUidMinter());

const uidOf = (op: BlockOp): string | null => (op.op === "create_page" ? null : op.uid);

describe("ops start states", () => {
  const samples = fc.sample(startStateArb, { numRuns: 200, seed: SEED });

  it("draws unique server-valid uids from the pool into well-formed trees", () => {
    for (const s of samples) {
      const uids = startNodes(s).map((n) => n.uid);
      expect(new Set(uids).size).toBe(uids.length);
      for (const uid of uids) {
        expect(uid).toMatch(UID_RE);
        expect(UID_POOL).toContain(uid);
      }
      for (const p of OPS_PAGES) {
        expect(treeProblems(s.pages[p])).toEqual([]);
        expect(allNodes(s.pages[p]).length).toBeLessThanOrEqual(10);
        expect(depth(s.pages[p])).toBeLessThanOrEqual(4);
      }
    }
  });

  it("never names Ops Four in seed text", () => {
    for (const s of samples) {
      for (const n of startNodes(s)) expect(n.text).not.toContain("Ops Four");
    }
  });

  it("reaches refs, gaps, nesting, empty pages and every page", () => {
    const texts = samples.flatMap((s) => startNodes(s).map((n) => n.text));
    expect(texts.some((t) => t.includes("[[Outline Props]]"))).toBe(true);
    expect(texts.some((t) => t.includes("[[Ops Two]]"))).toBe(true);
    expect(texts.some((t) => t.includes("#[[Ops Three]]"))).toBe(true);
    expect(texts.some((t) => /\(\(opsb\d\d\)\)/.test(t))).toBe(true);
    expect(samples.some((s) => OPS_PAGES.some((p) => s.pages[p].length === 0))).toBe(true);
    expect(samples.some((s) => OPS_PAGES.some((p) => depth(s.pages[p]) >= 3))).toBe(true);
    expect(samples.some((s) => OPS_PAGES.some((p) => allNodes(s.pages[p]).length === 10)))
      .toBe(true);
    const gapped = (sibs: BlockNode[]): boolean =>
      sibs.some((n, i) => (i === 0 ? n.order_idx > 0 : n.order_idx - sibs[i - 1].order_idx > 1)
        || gapped(n.children));
    expect(samples.some((s) => OPS_PAGES.some((p) => gapped(s.pages[p])))).toBe(true);
    const nodes = samples.flatMap(startNodes);
    expect(nodes.some((n) => n.collapsed)).toBe(true);
    expect(nodes.some((n) => n.heading !== null)).toBe(true);
    expect(nodes.some((n) => n.view_type !== null)).toBe(true);
  });

  it("seedOps rebuilds each page's start tree, keys included", () => {
    for (const s of samples) {
      const ops = seedOps(s);
      expect(ops.filter((o) => o.op === "create_page").map((o) => o.page_title))
        .toEqual([...OPS_PAGES]);
      for (const p of OPS_PAGES) expect(applyOps([], ops, p)).toEqual(s.pages[p]);
    }
  });

  it("seedOps creates every parent before its children", () => {
    for (const s of samples) {
      const made = new Set<string>();
      for (const op of seedOps(s)) {
        if (op.op !== "create") continue;
        if (op.parent_uid != null) expect(made.has(op.parent_uid)).toBe(true);
        made.add(op.uid);
      }
    }
  });
});

describe("resolveRaw", () => {
  it("names only the pool pages' blocks", () => {
    for (const drafts of fc.sample(rawBatchArb, { numRuns: 300, seed: SEED })) {
      for (const op of resolve(drafts)) {
        expect(JSON.stringify(op)).not.toContain("pt_seed_1");
      }
    }
  });

  it("resolves a cycle draft to a move under the block's own child", () => {
    const [op] = resolve([{
      kind: "move", target: { of: "live", n: 0 }, parent: { to: "cycle", n: 1 },
      page: null, slot: { at: "zero" },
    }]);
    expect(op).toMatchObject({ op: "move", uid: "opsb00", parent_uid: "opsb01", order_idx: 0 });
  });

  it("resolves a missing-parent draft to a uid outside the graph", () => {
    const ops = resolve([
      { kind: "create", uid: null, parent: { to: "missing", n: 3 }, page: "Ops Two",
        slot: { at: "zero" }, text: "x", heading: null, view_type: null },
      { kind: "move", target: { of: "live", n: 1 }, parent: { to: "missing", n: 0 },
        page: null, slot: { at: "zero" } },
    ]);
    const known = new Set(GRAPH.blocks.map((b) => b.uid));
    for (const op of ops) {
      expect(op.op === "create" || op.op === "move").toBe(true);
      const parent = (op as { parent_uid: string | null }).parent_uid;
      expect(parent).not.toBeNull();
      expect(parent).toMatch(UID_RE);
      expect(known.has(parent as string)).toBe(false);
      expect(ops.some((o) => uidOf(o) === parent)).toBe(false);
    }
    expect(ops[0]).toMatchObject({ op: "create", uid: "opsc00", page_title: "Ops Two" });
  });

  it("resolves a double-named pair to two ops on one uid", () => {
    const create: RawDraft = {
      kind: "create", uid: null, parent: { to: "top" }, page: null, slot: { at: "end", n: 0 },
      text: "", heading: null, view_type: null,
    };
    const move: RawDraft = {
      kind: "move", target: { of: "live", n: 3 }, parent: { to: "same" }, page: null,
      slot: { at: "zero" },
    };
    const again: RawDraft = {
      kind: "move", target: { of: "first" }, parent: { to: "top" }, page: null,
      slot: { at: "zero" },
    };
    for (const first of [create, move]) {
      const ops = resolve([first, again]);
      expect(ops).toHaveLength(2);
      expect(ops[1].op).toBe("move");
      expect(uidOf(ops[1])).toBe(uidOf(ops[0]));
    }
  });

  it("resolves stale hashes to differ from the live text's, matching ones to equal it", () => {
    const upd = (hash: "none" | "match" | "stale"): RawDraft =>
      ({ kind: "update_text", target: { of: "live", n: 0 }, text: "new", hash });
    const del = (hash: "none" | "match" | "stale"): RawDraft =>
      ({ kind: "delete", target: { of: "live", n: 0 }, hash });
    const [stale] = resolve([upd("stale")]);
    const [match] = resolve([upd("match")]);
    const [none] = resolve([upd("none")]);
    expect(stale).toMatchObject({ op: "update_text", uid: "opsb00" });
    expect((stale as { base_text_hash: string }).base_text_hash).not.toBe(sha256Hex("a"));
    expect((match as { base_text_hash: string }).base_text_hash).toBe(sha256Hex("a"));
    expect("base_text_hash" in none).toBe(false);
    const live = subtreeHash([["opsb00", "a"], ["opsb01", "b"], ["opsb02", "c"]]);
    const [dStale] = resolve([del("stale")]);
    const [dMatch] = resolve([del("match")]);
    expect((dMatch as { base_subtree_hash: string }).base_subtree_hash).toBe(live);
    expect((dStale as { base_subtree_hash: string }).base_subtree_hash).not.toBe(live);
  });

  it("matches against text the batch itself wrote", () => {
    const ops = resolve([
      { kind: "update_text", target: { of: "live", n: 1 }, text: "B", hash: "none" },
      { kind: "update_text", target: { of: "live", n: 1 }, text: "C", hash: "match" },
      { kind: "delete", target: { of: "live", n: 0 }, hash: "match" },
    ]);
    expect((ops[1] as { base_text_hash: string }).base_text_hash).toBe(sha256Hex("B"));
    expect((ops[2] as { base_subtree_hash: string }).base_subtree_hash)
      .toBe(subtreeHash([["opsb00", "a"], ["opsb01", "C"], ["opsb02", "c"]]));
  });

  it("aims a gone target at a block the batch deleted", () => {
    const ops = resolve([
      { kind: "delete", target: { of: "live", n: 3 }, hash: "none" },
      { kind: "update_text", target: { of: "gone", n: 0 }, text: "late", hash: "none" },
    ]);
    expect(ops[1]).toMatchObject({ op: "update_text", uid: "opsb03" });
  });

  it("places slots at zero, on a sibling, in a gap and past the end", () => {
    const slot = (s: RawSlot) =>
      resolve([{ kind: "move", target: { of: "live", n: 0 }, parent: { to: "top" },
                 page: "Ops Two", slot: s }])[0];
    expect(slot({ at: "zero" })).toMatchObject({ order_idx: 0, page_title: "Ops Two" });
    expect(slot({ at: "sibling", n: 1 })).toMatchObject({ order_idx: 5 });
    // Ops Two's free keys below its last are 0, 1, 3 and 4.
    expect(slot({ at: "gap", n: 2 })).toMatchObject({ order_idx: 3 });
    expect(slot({ at: "end", n: 1 })).toMatchObject({ order_idx: 7 });
  });

  it("can create a live uid, the rare 400", () => {
    const [op] = resolve([{ kind: "create", uid: { of: "live", n: 2 }, parent: { to: "top" },
                            page: null, slot: { at: "zero" }, text: "", heading: null,
                            view_type: null }]);
    expect(op).toMatchObject({ op: "create", uid: "opsb02", page_title: "Outline Props" });
  });
});

describe("rawUidMinter", () => {
  it("mints distinct server-valid opsc uids, each minter from the start", () => {
    const mint = rawUidMinter();
    const uids = Array.from({ length: 150 }, mint);
    expect(new Set(uids).size).toBe(150);
    for (const uid of uids) expect(uid).toMatch(/^opsc\d+$/);
    for (const uid of uids) expect(uid).toMatch(UID_RE);
    expect(rawUidMinter()()).toBe(uids[0]);
  });
});

describe("raw batches", () => {
  const batches = fc.sample(rawBatchArb, { numRuns: 2000, seed: SEED });
  const share = (pred: (d: RawDraft[]) => boolean): number =>
    batches.filter(pred).length / batches.length;

  it("hold 1 to 6 drafts", () => {
    for (const b of batches) {
      expect(b.length).toBeGreaterThanOrEqual(1);
      expect(b.length).toBeLessThanOrEqual(6);
    }
  });

  it("name one block twice about one time in four", () => {
    const s = share((b) => b.some((d) => "target" in d && d.target.of === "first"));
    expect(s).toBeGreaterThanOrEqual(0.15);
    expect(s).toBeLessThanOrEqual(0.35);
  });

  it("carry a forbidden title about one time in thirty", () => {
    const s = share((b) => findOpTitleViolation(resolve(b)) !== null);
    expect(s).toBeGreaterThanOrEqual(0.01);
    expect(s).toBeLessThanOrEqual(0.07);
  });

  it("reach every op kind and variation", () => {
    const drafts = batches.flat();
    const kinds = new Set(drafts.map((d) => d.kind));
    expect([...kinds].sort()).toEqual(["create", "create_page", "delete", "move", "set_collapsed",
                                       "set_heading", "set_view_type", "update_text"]);
    const has = (pred: (d: RawDraft) => boolean): boolean => drafts.some(pred);
    for (const to of ["top", "same", "live", "cycle", "missing"]) {
      expect(has((d) => d.kind === "move" && d.parent.to === to)).toBe(true);
    }
    for (const to of ["top", "live", "missing"]) {
      expect(has((d) => d.kind === "create" && d.parent.to === to)).toBe(true);
    }
    for (const at of ["zero", "sibling", "gap", "end"]) {
      expect(has((d) => "slot" in d && d.slot.at === at)).toBe(true);
    }
    for (const hash of ["none", "match", "stale"]) {
      expect(has((d) => d.kind === "update_text" && d.hash === hash)).toBe(true);
      expect(has((d) => d.kind === "delete" && d.hash === hash)).toBe(true);
    }
    expect(has((d) => d.kind === "update_text" && d.target.of === "gone")).toBe(true);
    expect(has((d) => d.kind === "create" && d.uid !== null)).toBe(true);
    expect(has((d) => d.kind === "move" && d.parent.to === "top" && d.page === "Ops Four"))
      .toBe(true);
    for (const title of TITLE_POOL) {
      expect(has((d) => d.kind === "create" && d.page === title)).toBe(true);
    }
  });

  it("never write Ops Four into text", () => {
    for (const d of batches.flat()) {
      if (d.kind === "create" || d.kind === "update_text") expect(d.text).not.toContain("Ops Four");
    }
  });

  it("resolve to server-valid fresh uids", () => {
    for (const b of batches.slice(0, 300)) {
      for (const op of resolve(b)) {
        const uid = uidOf(op);
        if (uid !== null) expect(uid).toMatch(UID_RE);
      }
    }
  });
});

describe("examples", () => {
  const examples = fc.sample(exampleArb, { numRuns: 500, seed: SEED });

  it("mix raw and command examples about 3 to 2", () => {
    const raw = examples.filter((e) => e.kind === "raw").length / examples.length;
    expect(raw).toBeGreaterThan(0.45);
    expect(raw).toBeLessThan(0.75);
  });

  it("hold 1 to 3 raw steps, with another device's batch about half the time", () => {
    const steps = examples.flatMap((e) => (e.kind === "raw" ? e.steps : []));
    for (const e of examples) {
      if (e.kind !== "raw") continue;
      expect(e.steps.length).toBeGreaterThanOrEqual(1);
      expect(e.steps.length).toBeLessThanOrEqual(3);
    }
    const other = steps.filter((s) => s.other !== null).length / steps.length;
    expect(other).toBeGreaterThan(0.35);
    expect(other).toBeLessThan(0.65);
  });

  it("hold 1 to 5 commands", () => {
    for (const e of examples) {
      if (e.kind !== "command") continue;
      expect(e.commands.length).toBeGreaterThanOrEqual(1);
      expect(e.commands.length).toBeLessThanOrEqual(5);
    }
  });
});
