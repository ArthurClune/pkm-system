// pkm-tu3a: onPasteOutline is the imperative half of planOutlinePaste — one
// flushed, optimistic, synced, undoable batch per paste gesture.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, type SyncFake } from "../test-helpers";
import { useOutline, type Outline } from "./useOutline";

vi.mock("../uid", () => {
  let n = 0;
  return { newUid: () => `n${++n}` };
});

function Harness({ pageTitle, initial, onReady }: {
  pageTitle: string;
  initial: BlockNode[];
  onReady: (o: Outline) => void;
}) {
  const outline = useOutline(pageTitle, initial);
  useEffect(() => onReady(outline));
  return null;
}

function setup(sync: SyncFake, pageTitle: string, initial: BlockNode[]) {
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness pageTitle={pageTitle} initial={initial}
               onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return () => outline;
}

it("onPasteOutline enqueues one batch and focuses the last pasted block", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [
    block("a", "seed", { order_idx: 0 }),
  ]);

  act(() => getOutline().handlers.onPasteOutline("a", 4, 4, "!\nnext\n\tkid"));

  expect(sync.sent).toEqual([[
    { op: "update_text", uid: "a", text: "seed!" },
    { op: "create", uid: expect.any(String), page_title: "Page",
      parent_uid: null, order_idx: 1, text: "next" },
    { op: "create", uid: expect.any(String), page_title: "Page",
      parent_uid: expect.any(String), order_idx: 0, text: "kid" },
  ]]);
  const [, createNext, createKid] = sync.sent[0] as
    [unknown, { uid: string }, { parent_uid: string; uid: string }];
  expect(createKid.parent_uid).toBe(createNext.uid);
  expect(getOutline().blocks.map((b) => b.text)).toEqual(["seed!", "next"]);
  expect(getOutline().blocks[1].children.map((b) => b.text)).toEqual(["kid"]);
  expect(getOutline().focus).toEqual({ uid: createKid.uid,
                                       cursor: "kid".length });
});

it("a paste that plans nothing enqueues nothing", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [
    block("a", "seed", { order_idx: 0 }),
  ]);
  act(() => getOutline().handlers.onPasteOutline("gone", 0, 0, "x\ny"));
  expect(sync.sent).toEqual([]);
});
