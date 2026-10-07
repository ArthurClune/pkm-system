// onDropFiles: files dropped from outside the app become one new block each,
// at the drop target, in one undo step.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, jsonResponse, makeSync, ord, type SyncFake, title, uid } from "../test-helpers";
import type { DropTarget } from "./dnd";
import { resetHistory } from "./undoManager";
import { useOutline, type Outline } from "./useOutline";

function Harness({ initial, onReady }: {
  initial: BlockNode[]; onReady: (o: Outline) => void;
}) {
  const outline = useOutline(title("Page"), initial);
  useEffect(() => onReady(outline));
  return (
    <div>{outline.blocks.map((b) => <div key={b.uid} data-uid={b.uid} />)}</div>);
}

function setup(sync: SyncFake, initial: BlockNode[]) {
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness initial={initial} onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return () => outline;
}

const asset = (name: string) => {
  const sha = name.charCodeAt(0).toString(16).padStart(2, "0").repeat(32);
  const mime = name.endsWith(".pdf") ? "application/pdf" : "image/png";
  return { sha256: sha, filename: name, mime, size: 1, url: `/assets/${sha}/${name}` };
};
const md = (name: string) => {
  const a = asset(name);
  return a.mime.startsWith("image/") ? `![${name}](${a.url})` : `[${name}](${a.url})`;
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const f = (init.body as FormData).get("file") as File;
    if (f.name.startsWith("bad")) return jsonResponse({ detail: "disk full" }, 500);
    return jsonResponse(asset(f.name));
  }));
});
afterEach(() => { resetHistory(); vi.unstubAllGlobals(); });

const png = (name: string) => new File(["x"], name, { type: "image/png" });
const pdf = (name: string) => new File(["x"], name, { type: "application/pdf" });
const AB = () => [block("a", "alpha", { order_idx: ord(0) }),
                  block("b", "beta", { order_idx: ord(1) })];
const at = (parent: string | null, idx: number): DropTarget =>
  ({ parent_uid: parent === null ? null : uid(parent), order_idx: ord(idx),
     page_title: "Page" });
const drop = async (o: () => Outline, files: File[], target: DropTarget) => {
  await act(async () => { await o().onDropFiles(files, target); });
};

it("creates one block per file, in drop order, at the target", async () => {
  const sync = makeSync();
  const o = setup(sync, AB());
  await drop(o, [png("c.png"), pdf("d.pdf")], at(null, 1));

  expect(o().blocks.map((b) => b.text))
    .toEqual(["alpha", md("c.png"), md("d.pdf"), "beta"]);
  expect(sync.sent).toHaveLength(1); // one batch
  expect(o().uploadError).toBeNull();
});

it("one undo removes every new block", async () => {
  const sync = makeSync();
  const o = setup(sync, AB());
  await drop(o, [png("c.png"), pdf("d.pdf")], at(null, 1));
  act(() => o().handlers.onUndo());
  expect(o().blocks.map((b) => b.uid)).toEqual(["a", "b"]);
});

it("a failed upload is named in the banner and makes no block", async () => {
  const sync = makeSync();
  const o = setup(sync, AB());
  await drop(o, [png("bad.png"), png("ok.png")], at(null, 1));
  expect(o().uploadError).toContain("bad.png");
  expect(o().blocks.map((b) => b.text)).toEqual(["alpha", md("ok.png"), "beta"]);
});

it("creates nothing when every upload fails", async () => {
  const sync = makeSync();
  const o = setup(sync, AB());
  await drop(o, [png("bad.png")], at(null, 1));
  expect(o().uploadError).toContain("bad.png");
  expect(sync.sent).toEqual([]);
  expect(o().blocks).toHaveLength(2);
});

it("names files that are not images or PDFs instead of skipping them silently",
   async () => {
  const sync = makeSync();
  const o = setup(sync, AB());
  await drop(o, [png("c.png"), new File(["x"], "notes.txt", { type: "text/plain" })],
             at(null, 1));
  expect(o().uploadError).toContain("notes.txt");
  expect(o().blocks.map((b) => b.text)).toEqual(["alpha", md("c.png"), "beta"]);
  const uploads = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.body instanceof FormData);
  expect(uploads).toHaveLength(1); // the text file was never uploaded
});

it("drops into an empty page", async () => {
  const sync = makeSync();
  const o = setup(sync, []);
  await drop(o, [png("c.png")], at(null, 0));
  expect(o().blocks.map((b) => b.text)).toEqual([md("c.png")]);
});

it("leaves focus where it was", async () => {
  const sync = makeSync();
  const o = setup(sync, AB());
  act(() => o().handlers.onFocusBlock(uid("a"), 2));
  await drop(o, [png("c.png")], at(null, 1));
  expect(o().focus).toEqual({ uid: "a", cursor: 2 });
});

it("a vanished parent puts the blocks at the end of the page and scrolls to the first",
   async () => {
  const scrolled: Element[] = [];
  const scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this); });
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
  const sync = makeSync();
  const o = setup(sync, AB());
  act(() => o().handlers.onFocusBlock(uid("a"), 0));
  await drop(o, [png("c.png"), pdf("d.pdf")], at("gone", 0));

  expect(o().blocks.map((b) => b.text)).toEqual(["alpha", "beta", md("c.png"), md("d.pdf")]);
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  expect(scrolled[0]).toBe(
    document.querySelector(`[data-uid="${o().blocks[2].uid}"]`));
  expect(o().focus).toEqual({ uid: "a", cursor: 0 }); // never focused the new block
});

it("does not scroll when the target held", async () => {
  const scrollIntoView = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
  const sync = makeSync();
  const o = setup(sync, AB());
  await drop(o, [png("c.png")], at(null, 1));
  expect(scrollIntoView).not.toHaveBeenCalled();
});
