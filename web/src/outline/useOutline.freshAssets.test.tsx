// Every upload path hands the history entry the shas it freshly stored (a
// dedup hit is never listed), so discarding the entry can release them.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Sha256Hex } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, jsonResponse, makeSync, ord, type SyncFake, title, uid } from "../test-helpers";
import type { DropTarget } from "./dnd";
import * as undoManager from "./undoManager";
import { useOutline, type Outline } from "./useOutline";

function Harness({ initial, onReady }: {
  initial: BlockNode[]; onReady: (o: Outline) => void;
}) {
  const outline = useOutline(title("Page"), initial);
  useEffect(() => onReady(outline));
  return null;
}

function setup(sync: SyncFake, initial: BlockNode[]) {
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness initial={initial} onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return () => outline;
}

const shaOf = (name: string) =>
  name.charCodeAt(0).toString(16).padStart(2, "0").repeat(32);
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const f = (init.body as FormData).get("file") as File;
    const sha = shaOf(f.name);
    return jsonResponse({ sha256: sha, filename: f.name, mime: "image/png", size: 1,
                          url: `/assets/${sha}/${f.name}`,
                          existing: f.name.startsWith("old") });
  }));
});
afterEach(() => { undoManager.resetHistory(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const png = (name: string) => new File(["x"], name, { type: "image/png" });
const AB = () => [block("a", "alpha", { order_idx: ord(0) }),
                  block("b", "beta", { order_idx: ord(1) })];
const target: DropTarget = { parent_uid: null, order_idx: ord(1), page_title: "Page" };

function recorded() {
  const spy = vi.spyOn(undoManager, "recordHistory");
  return () => spy.mock.calls.map(([entry]) => entry.freshAssets);
}

it("/upload of a fresh file records its sha", async () => {
  const seen = recorded();
  const o = setup(makeSync(), AB());
  await act(async () => { await o().handlers.onFiles(uid("a"), 5, [png("cat.png")]); });
  expect(seen()).toEqual([[shaOf("cat.png")]]);
});

it("a mixed batch records only the fresh sha", async () => {
  const seen = recorded();
  const o = setup(makeSync(), AB());
  await act(async () => {
    await o().handlers.onFiles(uid("a"), 5, [png("old.png"), png("new.png")]);
  });
  expect(seen()).toEqual([[shaOf("new.png")]]);
});

it("a dedup-only upload records no fresh assets", async () => {
  const seen = recorded();
  const o = setup(makeSync(), AB());
  await act(async () => { await o().handlers.onFiles(uid("a"), 5, [png("old.png")]); });
  expect(seen()).toEqual([[]]);
});

it("onDropFiles records the fresh shas of every block it creates", async () => {
  const seen = recorded();
  const o = setup(makeSync(), AB());
  await act(async () => {
    await o().onDropFiles([png("one.png"), png("old.png"), png("two.png")], target);
  });
  expect(seen()).toEqual([[shaOf("one.png"), shaOf("two.png")]]);
});

it("appendBlock passes freshAssets through", () => {
  const seen = recorded();
  const o = setup(makeSync(), AB());
  const sha = shaOf("p.png") as Sha256Hex;
  act(() => o().appendBlock("hi", [sha]));
  expect(seen()).toEqual([[sha]]);
});
