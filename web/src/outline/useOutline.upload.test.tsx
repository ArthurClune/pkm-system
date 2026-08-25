// pkm-gbsb: handlers.onFiles is the imperative half of the /upload, paste,
// and drag-drop paths — it calls uploadAsset per file and splices the
// resulting markdown into the block. This covers the error-surfacing half:
// a failed upload used to be swallowed by an empty catch with zero user
// feedback (verified failing before the fix); now it must set a visible
// uploadError and leave the block text untouched.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, defer, jsonResponse, makeSync, stubFetch,
         type SyncFake } from "../test-helpers";
import { findNode } from "./tree";
import { useOutline, type Outline } from "./useOutline";

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

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const INFO = { sha256: "ab".repeat(32), filename: "cat.png",
               mime: "image/png", size: 3, url: `/assets/${"ab".repeat(32)}/cat.png` };

it("onFiles splices the uploaded asset's markdown at the given offset", async () => {
  const sync = makeSync();
  stubFetch([["/api/assets", INFO]]);
  const getOutline = setup(sync, "Page", [block("u1", "hello")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  await act(async () => {
    getOutline().handlers.onFiles("u1", 5, [file]);
    await flush();
  });

  expect(getOutline().uploadError).toBeNull();
  expect(findNode(getOutline().blocks, "u1")!.text)
    .toBe(`hello![cat.png](${INFO.url})`);
});

it("a failed upload sets a visible uploadError and leaves the text untouched "
   + "(pkm-gbsb)", async () => {
  const sync = makeSync();
  stubFetch([]); // /api/assets 404s -> ApiError
  const getOutline = setup(sync, "Page", [block("u1", "hello")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  await act(async () => {
    getOutline().handlers.onFiles("u1", 5, [file]);
    await flush();
  });

  expect(getOutline().uploadError).not.toBeNull();
  expect(getOutline().uploadError).toContain("cat.png");
  expect(sync.sent).toEqual([]); // no splice op enqueued
  expect(findNode(getOutline().blocks, "u1")!.text).toBe("hello");
});

it("dismissUploadError clears the message", async () => {
  const sync = makeSync();
  stubFetch([]);
  const getOutline = setup(sync, "Page", [block("u1", "hello")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  await act(async () => {
    getOutline().handlers.onFiles("u1", 5, [file]);
    await flush();
  });
  expect(getOutline().uploadError).not.toBeNull();

  act(() => getOutline().dismissUploadError());

  expect(getOutline().uploadError).toBeNull();
});

// pkm-s6i6: the /upload slash command opens a native file dialog, which
// blurs the block before onFiles ever runs — focus is already null when the
// upload starts. Re-focusing unconditionally on completion used to swap the
// block back to a raw-markdown textarea, hiding the just-uploaded image
// until the user moved the cursor away.
it("the /upload dialog path leaves focus null after the splice (pkm-s6i6)",
   async () => {
  const sync = makeSync();
  stubFetch([["/api/assets", INFO]]);
  const getOutline = setup(sync, "Page", [block("u1", "hello")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  expect(getOutline().focus).toBeNull();

  await act(async () => {
    getOutline().handlers.onFiles("u1", 5, [file]);
    await flush();
  });

  expect(findNode(getOutline().blocks, "u1")!.text)
    .toBe(`hello![cat.png](${INFO.url})`);
  expect(getOutline().focus).toBeNull();
});

it("the paste/drop path restores focus with the caret past the spliced "
   + "markdown (pkm-s6i6)", async () => {
  const sync = makeSync();
  stubFetch([["/api/assets", INFO]]);
  const getOutline = setup(sync, "Page", [block("u1", "hello")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  act(() => getOutline().handlers.onFocusBlock("u1", 5));

  await act(async () => {
    getOutline().handlers.onFiles("u1", 5, [file]);
    await flush();
  });

  const spliced = `hello![cat.png](${INFO.url})`;
  expect(findNode(getOutline().blocks, "u1")!.text).toBe(spliced);
  expect(getOutline().focus).toEqual({ uid: "u1", cursor: spliced.length });
});

it("moving focus to another block during a slow upload leaves it there "
   + "(pkm-s6i6)", async () => {
  const sync = makeSync();
  const deferred = defer<Response>();
  vi.stubGlobal("fetch", vi.fn(async () => deferred.promise));
  const getOutline = setup(sync, "Page",
    [block("u1", "hello"), block("u2", "world")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  act(() => getOutline().handlers.onFocusBlock("u1", 5));
  act(() => getOutline().handlers.onFiles("u1", 5, [file]));
  act(() => getOutline().handlers.onFocusBlock("u2", 0));

  await act(async () => {
    deferred.resolve(jsonResponse(INFO));
    await flush();
  });

  expect(findNode(getOutline().blocks, "u1")!.text)
    .toBe(`hello![cat.png](${INFO.url})`);
  expect(getOutline().focus).toEqual({ uid: "u2", cursor: 0 });
});

it("starting a new upload clears a stale error from a previous failure", async () => {
  const sync = makeSync();
  const fetchMock = stubFetch([]);
  const getOutline = setup(sync, "Page", [block("u1", "hello")]);
  const file = new File(["x"], "cat.png", { type: "image/png" });

  await act(async () => {
    getOutline().handlers.onFiles("u1", 5, [file]);
    await flush();
  });
  expect(getOutline().uploadError).not.toBeNull();

  fetchMock.mockImplementationOnce(async () => new Response(
    JSON.stringify(INFO), { status: 200,
      headers: { "Content-Type": "application/json" } }));
  await act(async () => {
    getOutline().handlers.onFiles("u1", 5, [file]);
    await flush();
  });

  expect(getOutline().uploadError).toBeNull();
});
