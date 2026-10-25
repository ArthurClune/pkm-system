// run() refuses a command that would put a block past the outline depth
// cap: none of the command's ops apply or ship, the pending draft's text
// still does, and the outline raises the depth notice.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { sha256Hex } from "../replica/sha256";
import { SyncContext } from "../sync/SyncProvider";
import { block, canonicalTitleOf, makeSync, orderIdxOf, type SyncFake,
         uidOf } from "../test-helpers";
import { DEPTH_NOTICE } from "./depthCap";
import type { BlockOp } from "../api/ops";
import { peekOutlineSession } from "./outlineSessions";
import { findNode, locate } from "./tree";
import { performUndo, resetHistory } from "./undoManager";
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
  return null;
}

function setup(sync: SyncFake) {
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness initial={deepTree()} onReady={(o) => { outline = o; }} />
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
