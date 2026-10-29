// onPasteOutline is the imperative half of planOutlinePaste — one
// flushed, optimistic, synced, undoable batch per paste gesture.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { sha256Hex } from "../replica/sha256";
import { BATCH_TOO_LARGE_NOTICE } from "../sync/batchLimits";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, orderIdxOf, type SyncFake, canonicalTitleOf, uidOf } from "../test-helpers";
import { resetHistory } from "./undoManager";
import { useOutline, type Outline } from "./useOutline";

vi.mock("../uid", () => {
  let n = 0;
  const next = () => `n${++n}`;
  return {
    newUid: next, newRawUid: next, newClientId: next, newBatchId: next,
  };
});

function Harness({ titleText, initial, onReady }: {
  titleText: string;
  initial: BlockNode[];
  onReady: (o: Outline) => void;
}) {
  const outline = useOutline(canonicalTitleOf(titleText), initial);
  useEffect(() => onReady(outline));
  return null;
}

function setup(sync: SyncFake, titleText: string, initial: BlockNode[]) {
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness titleText={titleText} initial={initial}
               onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return () => outline;
}

afterEach(() => resetHistory());

it("onPasteOutline enqueues one batch and focuses the last pasted block", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [
    block("tuid-a", "seed", { order_idx: orderIdxOf(0) }),
  ]);

  act(() => getOutline().handlers.onPasteOutline(uidOf("tuid-a"), 4, 4, "!\nnext\n\tkid"));

  expect(sync.sent).toEqual([[
    { op: "update_text", uid: "tuid-a", text: "seed!",
      base_text_hash: sha256Hex("seed"), page_title: "Page" },
    { op: "create", uid: expect.any(String) as string, page_title: "Page",
      parent_uid: null, order_idx: 1, text: "next" },
    { op: "create", uid: expect.any(String) as string, page_title: "Page",
      parent_uid: expect.any(String) as string, order_idx: 0, text: "kid" },
  ]]);
  const [, createNext, createKid] = sync.sent[0] ?? [];
  if (createNext?.op !== "create" || createKid?.op !== "create") {
    throw new Error("expected the paste to create two blocks");
  }
  expect(createKid.parent_uid).toBe(createNext.uid);
  expect(getOutline().blocks.map((b) => b.text)).toEqual(["seed!", "next"]);
  expect(getOutline().blocks[1].children.map((b) => b.text)).toEqual(["kid"]);
  expect(getOutline().focus).toEqual({ uid: createKid.uid,
                                       cursor: "kid".length });
});

it("a paste is one undo entry: undo restores the pre-paste tree", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [
    block("tuid-a", "seed", { order_idx: orderIdxOf(0) }),
  ]);

  act(() => getOutline().handlers.onPasteOutline(uidOf("tuid-a"), 4, 4, "!\nnext\n\tkid"));
  expect(getOutline().blocks.map((b) => b.text)).toEqual(["seed!", "next"]);

  act(() => { getOutline().handlers.onUndo(); });

  expect(getOutline().blocks.map((b) => b.text)).toEqual(["seed"]);
  expect(getOutline().blocks[0].children).toEqual([]);
});

it("a paste that plans nothing enqueues nothing", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [
    block("tuid-a", "seed", { order_idx: orderIdxOf(0) }),
  ]);
  act(() => getOutline().handlers.onPasteOutline(uidOf("tuid-gone"), 0, 0, "x\ny"));
  expect(sync.sent).toEqual([]);
});

it("a paste past the server's op count per batch is refused", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [
    block("tuid-a", "seed", { order_idx: orderIdxOf(0) }),
  ]);
  const lines = Array.from({ length: 501 }, (_, i) => `line ${i}`);

  act(() => getOutline().handlers.onPasteOutline(
    uidOf("tuid-a"), 4, 4, `!\n${lines.join("\n")}`));

  expect(getOutline().editNotice).toBe(BATCH_TOO_LARGE_NOTICE);
  // the paste's own text splice is part of the refused command
  expect(sync.sent).toEqual([]);
  expect(getOutline().blocks.map((b) => b.text)).toEqual(["seed"]);
});
