// run() refuses a command that would put a block past the outline depth
// cap: none of the command's ops apply or ship, the pending draft's text
// still does, and the outline raises the depth notice.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { sha256Hex } from "../replica/sha256";
import { SyncContext } from "../sync/SyncProvider";
import { block, canonicalTitleOf, jsonResponse, makeSync, malformedUid,
         orderIdxOf, type SyncFake, uidOf } from "../test-helpers";
import type { DropTarget } from "./dnd";
import { DEPTH_NOTICE } from "./depthCap";
import type { BlockOp } from "../api/ops";
import { peekOutlineSession } from "./outlineSessions";
import { findNode, locate } from "./tree";
import { performUndo, resetHistory, setAssetReleaser } from "./undoManager";
import { useOutline, type Outline } from "./useOutline";

vi.mock("../uid", () => {
  let n = 0;
  const next = () => `n${++n}`;
  return {
    newUid: next, newRawUid: next, newClientId: next, newBatchId: next,
  };
});

const PAGE = "Deep";

function Harness({ initial, onReady }: {
  initial: BlockNode[];
  onReady: (o: Outline) => void;
}) {
  const outline = useOutline(canonicalTitleOf(PAGE), initial);
  useEffect(() => onReady(outline));
  // top-level blocks only: enough DOM for the scroll-to-new-block effect
  return <>{outline.blocks.map((b) => <div key={b.uid} data-uid={b.uid} />)}</>;
}

function setup(sync: SyncFake, initial: BlockNode[] = deepTree()) {
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness initial={initial} onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return () => outline;
}

/** d1 > d2 > ... > d98, and under d98: d99 (children d100a, d100b) then
 * d99b. Each block's name is its level; indenting d100b would put it at 101,
 * indenting d99b puts it at 100. */
function deepTree(): BlockNode[] {
  let node = block("tuid-d98", "d98", { children: [
    block("tuid-d99", "d99", { order_idx: orderIdxOf(0), children: [
      block("tuid-d100a", "d100a", { order_idx: orderIdxOf(0) }),
      block("tuid-d100b", "d100b", { order_idx: orderIdxOf(1) }),
    ] }),
    block("tuid-d99b", "d99b", { order_idx: orderIdxOf(1) }),
  ] });
  for (let level = 97; level >= 1; level--) {
    node = block(`tuid-d${level}`, `d${level}`, { children: [node] });
  }
  return [node];
}

const parentOf = (o: Outline, raw: string) =>
  locate(o.blocks, uidOf(raw))?.parent?.uid ?? null;

afterEach(() => resetHistory());

it("an indent past the cap applies nothing and raises the notice", () => {
  const sync = makeSync();
  const outline = setup(sync);
  const before = outline().blocks;

  act(() => outline().handlers.onIndent(uidOf("tuid-d100b")));

  expect(sync.sent).toEqual([]);
  expect(outline().blocks).toEqual(before);
  expect(outline().editNotice).toBe(DEPTH_NOTICE);
  // nothing was recorded: there is no entry to undo
  expect(performUndo(sync)).toBe(false);
});

it("a refused indent still ships and applies the block's draft", () => {
  const sync = makeSync();
  const outline = setup(sync);
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-d100b"), 5));
  act(() => outline().handlers.onDraftStart(uidOf("tuid-d100b"), "d100b"));
  act(() => outline().handlers.onDraftChange(uidOf("tuid-d100b"), "typed"));

  act(() => outline().handlers.onIndent(uidOf("tuid-d100b")));

  expect(sync.sent).toEqual([[
    { op: "update_text", uid: "tuid-d100b", text: "typed",
      base_text_hash: sha256Hex("d100b"), page_title: PAGE },
  ]]);
  expect(findNode(outline().blocks, uidOf("tuid-d100b"))?.text).toBe("typed");
  expect(parentOf(outline(), "tuid-d100b")).toBe("tuid-d99");
  expect(outline().editNotice).toBe(DEPTH_NOTICE);
});

it("a multi-block indent with one root past the cap moves none", () => {
  const sync = makeSync();
  const outline = setup(sync);
  // d100b then d99b in on-screen order: two roots under different parents
  act(() => outline().handlers.onStartBlockSelection(
    uidOf("tuid-d100b"), "down"));
  expect(outline().selection).toEqual(
    { anchor: "tuid-d100b", head: "tuid-d99b" });

  act(() => outline().handlers.onIndentSelection());

  expect(sync.sent).toEqual([]);
  expect(parentOf(outline(), "tuid-d100b")).toBe("tuid-d99");
  expect(parentOf(outline(), "tuid-d99b")).toBe("tuid-d98");
  expect(outline().editNotice).toBe(DEPTH_NOTICE);
});

it("a three-level paste at level 99 is refused, at level 98 applied", () => {
  const sync = makeSync();
  const outline = setup(sync);
  const pasted = "a\n\tb\n\t\tc";

  act(() => outline().handlers.onPasteOutline(
    uidOf("tuid-d99"), 3, 3, pasted));

  expect(sync.sent).toEqual([]);
  expect(findNode(outline().blocks, uidOf("tuid-d99"))?.text).toBe("d99");
  expect(outline().editNotice).toBe(DEPTH_NOTICE);

  act(() => outline().handlers.onPasteOutline(
    uidOf("tuid-d98"), 3, 3, pasted));

  expect(sync.sent).toHaveLength(1);
  expect(sync.sent[0].map((op) => op.op))
    .toEqual(["update_text", "create", "create"]);
  expect(findNode(outline().blocks, uidOf("tuid-d98"))?.text).toBe("d98a");
  expect(outline().editNotice).toBeNull();
});

it("an indent to the cap applies, and clears a shown notice", () => {
  const sync = makeSync();
  const outline = setup(sync);
  act(() => outline().handlers.onIndent(uidOf("tuid-d100b")));
  expect(outline().editNotice).toBe(DEPTH_NOTICE);

  act(() => outline().handlers.onIndent(uidOf("tuid-d99b")));

  expect(sync.sent).toEqual([
    [{ op: "move", uid: "tuid-d99b", parent_uid: "tuid-d99", order_idx: 2 }],
  ]);
  expect(parentOf(outline(), "tuid-d99b")).toBe("tuid-d99");
  expect(outline().editNotice).toBeNull();
});

it("an applied indent never raises the notice", () => {
  const sync = makeSync();
  const outline = setup(sync);
  act(() => outline().handlers.onIndent(uidOf("tuid-d99b")));
  expect(sync.sent).toHaveLength(1);
  expect(outline().editNotice).toBeNull();
});

it("dismissEditNotice clears the notice", () => {
  const sync = makeSync();
  const outline = setup(sync);
  act(() => outline().handlers.onIndent(uidOf("tuid-d100b")));
  expect(outline().editNotice).toBe(DEPTH_NOTICE);

  act(() => outline().dismissEditNotice());

  expect(outline().editNotice).toBeNull();
});

it("an undo the cap refuses raises the notice and applies nothing", () => {
  const sync = makeSync();
  const outline = setup(sync);
  act(() => outline().handlers.onOutdent(uidOf("tuid-d100b")));
  expect(parentOf(outline(), "tuid-d100b")).toBe("tuid-d98");
  // another device wraps d99 one level deeper, so the undo, putting d100b
  // back under d99, would reach level 101
  const wrap: BlockOp[] = [
    { op: "create", uid: uidOf("tuid-w"), page_title: canonicalTitleOf(PAGE),
      parent_uid: uidOf("tuid-d98"), order_idx: orderIdxOf(0), text: "w" },
    { op: "move", uid: uidOf("tuid-d99"), parent_uid: uidOf("tuid-w"),
      order_idx: orderIdxOf(0) },
  ];
  const handle = peekOutlineSession(canonicalTitleOf(PAGE))!;
  act(() => handle.applyLocal(sync.enqueue(wrap, ["page", PAGE]), wrap));
  handle.release();
  const sent = sync.sent.length;
  const before = outline().blocks;

  act(() => { performUndo(sync); });

  expect(sync.sent).toHaveLength(sent);
  expect(outline().blocks).toEqual(before);
  expect(outline().editNotice).toBe(DEPTH_NOTICE);
});

// Uploads finish before run() judges the command, so a refusal leaves the
// stored files unlinked unless the refusal releases them.
const digestOf = (name: string) =>
  name.charCodeAt(0).toString(16).padStart(2, "0").repeat(32);
const png = (name: string) => new File(["x"], name, { type: "image/png" });

function spyReleaser() {
  const release = vi.fn(async () => {});
  const restore = setAssetReleaser({ release });
  return { release, restore };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const f = (init.body as FormData).get("file") as File;
    const sha = digestOf(f.name);
    const filename = f.name === "long.png" ? "x".repeat(1_000_001) : f.name;
    return jsonResponse({ sha256: sha, filename, mime: "image/png", size: 1, url: `/assets/${sha}/${f.name}`,
                          existing: false });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

it("a file drop past the depth cap releases the files it uploaded", async () => {
  const { release, restore } = spyReleaser();
  const sync = makeSync();
  const outline = setup(sync);
  const target: DropTarget = { parent_uid: uidOf("tuid-d100a"), order_idx: orderIdxOf(0),
                               page_title: canonicalTitleOf(PAGE) };

  await act(async () => { await outline().onDropFiles([png("one.png")], target); });

  expect(outline().editNotice).toBe(DEPTH_NOTICE);
  expect(sync.sent).toEqual([]);
  expect(release).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledWith([digestOf("one.png")], []);
  restore();
});

it("an /upload past the depth cap releases the files, reports no insert",
   async () => {
  const { release, restore } = spyReleaser();
  const sync = makeSync();
  // a legacy block already at level 101: its next sibling would be too
  const legacy = deepTree();
  let d100a = legacy[0];
  while (d100a.uid !== uidOf("tuid-d99")) d100a = d100a.children[0];
  d100a.children[0].children = [
    block("tuid-d101", "d101", { order_idx: orderIdxOf(0) })];
  const outline = setup(sync, legacy);
  let inserted: boolean | void = undefined;

  await act(async () => {
    inserted = await outline().handlers.onFiles(
      uidOf("tuid-d101"), 0, [png("one.png")]);
  });

  expect(inserted).toBe(false);
  expect(outline().editNotice).toBe(DEPTH_NOTICE);
  expect(sync.sent).toEqual([]);
  expect(release).toHaveBeenCalledWith([digestOf("one.png")], []);
  restore();
});

it("a refused drop sets no scroll target", async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const { restore } = spyReleaser();
  const sync = makeSync();
  const outline = setup(sync);
  // a parent that has gone makes the plan fall back to the page end; the
  // file's stored name is too long for a block, so the command is refused
  const target: DropTarget = { parent_uid: uidOf("tuid-gone"), order_idx: orderIdxOf(0),
                               page_title: canonicalTitleOf(PAGE) };
  await act(async () => { await outline().onDropFiles([png("long.png")], target); });
  expect(sync.sent).toEqual([]);
  expect(outline().editNotice).not.toBeNull();

  // a later render adds a block under the uid the refused plan chose: the
  // mocked newUid counts up, so cover the uids it could have handed out
  const late: BlockOp[] = Array.from({ length: 40 }, (_, k) => ({
    op: "create" as const, uid: malformedUid(`n${k}`),
    page_title: canonicalTitleOf(PAGE), parent_uid: null,
    order_idx: orderIdxOf(k + 5), text: "late" }));
  const handle = peekOutlineSession(canonicalTitleOf(PAGE))!;
  act(() => handle.applyLocal(sync.enqueue(late, ["page", PAGE]), late));
  // a peeked handle holds the session: an unreleased one carries this
  // test's page into the next test's outline
  handle.release();

  expect(outline().blocks.length).toBeGreaterThan(1);
  expect(scrollIntoView).not.toHaveBeenCalled();
  restore();
});

// A page imported before the cap may already hold rows past it. Each
// command is judged by the blocks it places, so those rows leave the rest
// of the page, and their own text, editable.
describe("a page holding rows past the cap", () => {
  /** A legacy chain L1 > ... > L120, then shallow roots s1 and s2. */
  function legacyTree(): BlockNode[] {
    let node = block("tuid-L120", "L120");
    for (let level = 119; level >= 1; level--) {
      node = block(`tuid-L${level}`, `L${level}`, { children: [node] });
    }
    return [
      node,
      block("tuid-s1", "s1", { order_idx: orderIdxOf(1) }),
      block("tuid-s2", "s2", { order_idx: orderIdxOf(2) }),
    ];
  }

  it("an indent at a shallow level applies", () => {
    const sync = makeSync();
    const outline = setup(sync, legacyTree());
    console.log("PRE", outline().blocks.map(b=>b.uid).slice(0,5), outline().blocks.length, outline().editNotice);
    act(() => outline().handlers.onIndent(uidOf("tuid-s2")));
    console.log("DBG", outline().editNotice, outline().blocks.map(b=>b.uid));
    expect(sync.sent).toHaveLength(1);
    expect(parentOf(outline(), "tuid-s2")).toBe("tuid-s1");
    expect(outline().editNotice).toBeNull();
    // the undo is judged by the blocks it places, too
    act(() => { performUndo(sync); });
    expect(sync.sent).toHaveLength(2);
    expect(parentOf(outline(), "tuid-s2")).toBeNull();
    expect(outline().editNotice).toBeNull();
  });

  it("a subtree move at a shallow level applies", () => {
    const sync = makeSync();
    const outline = setup(sync, legacyTree());
    act(() => outline().handlers.onMoveSubtreeUp(uidOf("tuid-s2")));
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].map((op) => op.op)).toEqual(["move"]);
    expect(outline().blocks.map((b) => b.uid))
      .toEqual(["tuid-L1", "tuid-s2", "tuid-s1"]);
    expect(outline().editNotice).toBeNull();
  });

  it("a paste at a shallow level applies", () => {
    const sync = makeSync();
    const outline = setup(sync, legacyTree());
    act(() => outline().handlers.onPasteOutline(
      uidOf("tuid-s1"), 2, 2, "a\n\tb"));
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].map((op) => op.op))
      .toEqual(["update_text", "create"]);
    expect(findNode(outline().blocks, uidOf("tuid-s1"))?.text).toBe("s1a");
    expect(outline().editNotice).toBeNull();
  });

  it("the deep rows' text stays editable", () => {
    const sync = makeSync();
    const outline = setup(sync, legacyTree());
    const deep = uidOf("tuid-L120");
    act(() => outline().handlers.onFocusBlock(deep, 4));
    act(() => outline().handlers.onDraftStart(deep, "L120"));
    act(() => outline().handlers.onDraftChange(deep, "deep edit"));
    act(() => outline().handlers.onFlushDraft());
    expect(sync.sent).toEqual([[
      { op: "update_text", uid: "tuid-L120", text: "deep edit",
        base_text_hash: sha256Hex("L120"), page_title: PAGE },
    ]]);
    expect(findNode(outline().blocks, deep)?.text).toBe("deep edit");
    expect(outline().editNotice).toBeNull();
  });
});
