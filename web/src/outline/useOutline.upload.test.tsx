// handlers.onFiles is the imperative half of the /upload, paste,
// and drag-drop paths — it calls uploadAsset per file and lands each result
// as its own block after the current one (an empty block takes the first).
// This also covers the error-surfacing half: a failed upload must set a
// visible uploadError and leave the block text untouched, never swallow the
// failure with zero user feedback.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, defer, jsonResponse, makeSync, stubFetch, canonicalTitleOf, type SyncFake,
         orderIdxOf, uidOf } from "../test-helpers";
import { findNode } from "./tree";
import { resetHistory } from "./undoManager";
import { useOutline, type Outline } from "./useOutline";

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

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => resetHistory());

const md = (info: { filename: string; url: string }) =>
  `![${info.filename}](${info.url})`;
const rootTexts = (o: Outline) => o.blocks.map((n) => n.text);

const INFO = { sha256: "ab".repeat(32), filename: "cat.png",
               mime: "image/png", size: 3, url: `/assets/${"ab".repeat(32)}/cat.png` };

it("onFiles adds the upload as a new block after one with text", async () => {
  const sync = makeSync();
  stubFetch([["/api/assets", INFO]]);
  const getOutline = setup(sync, "Page", [block("tuid-u1", "hello")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  await act(async () => {
    void getOutline().handlers.onFiles(uidOf("tuid-u1"), 5, [file]);
    await flush();
  });

  expect(getOutline().uploadError).toBeNull();
  expect(rootTexts(getOutline())).toEqual(["hello", md(INFO)]);
});

it("a failed upload sets a visible uploadError and leaves the text untouched",
   async () => {
  const sync = makeSync();
  stubFetch([]); // /api/assets 404s -> ApiError
  const getOutline = setup(sync, "Page", [block("tuid-u1", "hello")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  await act(async () => {
    void getOutline().handlers.onFiles(uidOf("tuid-u1"), 5, [file]);
    await flush();
  });

  expect(getOutline().uploadError).not.toBeNull();
  expect(getOutline().uploadError).toContain("cat.png");
  expect(sync.sent).toEqual([]); // no op enqueued
  expect(findNode(getOutline().blocks, uidOf("tuid-u1"))!.text).toBe("hello");
});

it("dismissUploadError clears the message", async () => {
  const sync = makeSync();
  stubFetch([]);
  const getOutline = setup(sync, "Page", [block("tuid-u1", "hello")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  await act(async () => {
    void getOutline().handlers.onFiles(uidOf("tuid-u1"), 5, [file]);
    await flush();
  });
  expect(getOutline().uploadError).not.toBeNull();

  act(() => getOutline().dismissUploadError());

  expect(getOutline().uploadError).toBeNull();
});

// The /upload pick blurs the block itself before onFiles ever runs —
// focus is already null when the upload starts. Re-focusing unconditionally
// on completion would swap the block back to a raw-markdown textarea,
// hiding the just-uploaded image until the user moved the cursor away.
it("the /upload dialog path adds a block and leaves focus null",
   async () => {
  const sync = makeSync();
  stubFetch([["/api/assets", INFO]]);
  const getOutline = setup(sync, "Page", [block("tuid-u1", "hello")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  expect(getOutline().focus).toBeNull();

  await act(async () => {
    void getOutline().handlers.onFiles(uidOf("tuid-u1"), 5, [file]);
    await flush();
  });

  expect(rootTexts(getOutline())).toEqual(["hello", md(INFO)]);
  expect(getOutline().focus).toBeNull();
});

it("a paste into a focused block with text leaves focus where it was",
   async () => {
  const sync = makeSync();
  stubFetch([["/api/assets", INFO]]);
  const getOutline = setup(sync, "Page", [block("tuid-u1", "hello")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  act(() => getOutline().handlers.onFocusBlock(uidOf("tuid-u1"), 5));

  await act(async () => {
    void getOutline().handlers.onFiles(uidOf("tuid-u1"), 5, [file]);
    await flush();
  });

  expect(rootTexts(getOutline())).toEqual(["hello", md(INFO)]);
  expect(getOutline().focus).toEqual({ uid: "tuid-u1", cursor: 5 });
});

it("a paste into a focused empty block fills it and focuses past the markdown",
   async () => {
  const sync = makeSync();
  stubFetch([["/api/assets", INFO]]);
  const getOutline = setup(sync, "Page", [block("tuid-u1", "")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  act(() => getOutline().handlers.onFocusBlock(uidOf("tuid-u1"), 0));

  await act(async () => {
    void getOutline().handlers.onFiles(uidOf("tuid-u1"), 0, [file]);
    await flush();
  });

  expect(rootTexts(getOutline())).toEqual([md(INFO)]);
  expect(getOutline().focus)
    .toEqual({ uid: "tuid-u1", cursor: md(INFO).length });
});

it("moving focus to another block during a slow upload leaves it there",
   async () => {
  const sync = makeSync();
  const deferred = defer<Response>();
  vi.stubGlobal("fetch", vi.fn(async () => deferred.promise));
  const getOutline = setup(sync, "Page",
    [block("tuid-u1", "hello", { order_idx: orderIdxOf(0) }),
     block("tuid-u2", "world", { order_idx: orderIdxOf(1) })]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  act(() => getOutline().handlers.onFocusBlock(uidOf("tuid-u1"), 5));
  act(() => { void getOutline().handlers.onFiles(uidOf("tuid-u1"), 5, [file]); });
  act(() => getOutline().handlers.onFocusBlock(uidOf("tuid-u2"), 0));

  await act(async () => {
    deferred.resolve(jsonResponse(INFO));
    await flush();
  });

  expect(rootTexts(getOutline())).toEqual(["hello", md(INFO), "world"]);
  expect(getOutline().focus).toEqual({ uid: "tuid-u2", cursor: 0 });
});

it("starting a new upload clears a stale error from a previous failure", async () => {
  const sync = makeSync();
  const fetchMock = stubFetch([]);
  const getOutline = setup(sync, "Page", [block("tuid-u1", "hello")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  await act(async () => {
    void getOutline().handlers.onFiles(uidOf("tuid-u1"), 5, [file]);
    await flush();
  });
  expect(getOutline().uploadError).not.toBeNull();

  fetchMock.mockImplementationOnce(async () => new Response(
    JSON.stringify(INFO), { status: 200,
      headers: { "Content-Type": "application/json" } }));
  await act(async () => {
    void getOutline().handlers.onFiles(uidOf("tuid-u1"), 5, [file]);
    await flush();
  });

  expect(getOutline().uploadError).toBeNull();
});

const DOG = { ...INFO, sha256: "cd".repeat(32), filename: "dog.png",
              url: `/assets/${"cd".repeat(32)}/dog.png` };

it("several uploads become sibling blocks in upload order, one undo entry",
   async () => {
  const sync = makeSync();
  const infos = [INFO, DOG];
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(infos.shift())));
  const getOutline = setup(sync, "Page", [block("tuid-u1", "hello")]);
  const files = [new File(["x"], "cat.png", { type: "image/png" }),
                 new File(["y"], "dog.png", { type: "image/png" })];

  await act(async () => {
    void getOutline().handlers.onFiles(uidOf("tuid-u1"), 5, files);
    await flush();
  });

  expect(rootTexts(getOutline())).toEqual(["hello", md(INFO), md(DOG)]);
  expect(sync.sent).toHaveLength(1);

  act(() => { getOutline().handlers.onUndo(); });
  expect(rootTexts(getOutline())).toEqual(["hello"]);
});

it("undo after filling an empty block restores it and removes the sibling",
   async () => {
  const sync = makeSync();
  const infos = [INFO, DOG];
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(infos.shift())));
  const getOutline = setup(sync, "Page", [block("tuid-u1", "")]);
  const files = [new File(["x"], "cat.png", { type: "image/png" }),
                 new File(["y"], "dog.png", { type: "image/png" })];

  await act(async () => {
    void getOutline().handlers.onFiles(uidOf("tuid-u1"), 0, files);
    await flush();
  });

  expect(rootTexts(getOutline())).toEqual([md(INFO), md(DOG)]);

  act(() => { getOutline().handlers.onUndo(); });
  expect(rootTexts(getOutline())).toEqual([""]);
});

it("a failed upload among several still lands the others", async () => {
  const sync = makeSync();
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => (
    calls++ === 0 ? jsonResponse(INFO)
      : jsonResponse({ detail: "boom" }, 500))));
  const getOutline = setup(sync, "Page", [block("tuid-u1", "hello")]);
  const files = [new File(["x"], "cat.png", { type: "image/png" }),
                 new File(["y"], "dog.png", { type: "image/png" })];

  await act(async () => {
    void getOutline().handlers.onFiles(uidOf("tuid-u1"), 5, files);
    await flush();
  });

  expect(rootTexts(getOutline())).toEqual(["hello", md(INFO)]);
  expect(getOutline().uploadError).toContain("dog.png");
});

it("an unflushed draft keeps the block non-empty", async () => {
  const sync = makeSync();
  stubFetch([["/api/assets", INFO]]);
  const getOutline = setup(sync, "Page", [block("tuid-u1", "")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  act(() => getOutline().handlers.onFocusBlock(uidOf("tuid-u1"), 0));
  act(() => getOutline().handlers.onDraftChange(uidOf("tuid-u1"), "typed"));

  await act(async () => {
    void getOutline().handlers.onFiles(uidOf("tuid-u1"), 5, [file]);
    await flush();
  });

  expect(rootTexts(getOutline())).toEqual(["typed", md(INFO)]);
});

it("a block deleted during the upload sends the blocks to the page end",
   async () => {
  const sync = makeSync();
  const deferred = defer<Response>();
  vi.stubGlobal("fetch", vi.fn(async () => deferred.promise));
  const getOutline = setup(sync, "Page",
    [block("tuid-u1", "keep", { order_idx: orderIdxOf(0) }),
     block("tuid-u2", "gone", { order_idx: orderIdxOf(1) })]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  act(() => { void getOutline().handlers.onFiles(uidOf("tuid-u2"), 4, [file]); });
  act(() => getOutline().handlers.onFocusBlock(uidOf("tuid-u2"), 0));
  act(() => {
    getOutline().handlers.onDraftChange(uidOf("tuid-u2"), "");
    getOutline().handlers.onBackspaceAtStart(uidOf("tuid-u2"));
  });
  expect(rootTexts(getOutline())).toEqual(["keep"]);

  await act(async () => {
    deferred.resolve(jsonResponse(INFO));
    await flush();
  });

  expect(rootTexts(getOutline())).toEqual(["keep", md(INFO)]);
});
