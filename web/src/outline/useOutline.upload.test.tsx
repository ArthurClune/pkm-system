// pkm-gbsb: handlers.onFiles is the imperative half of the /upload, paste,
// and drag-drop paths — it calls uploadAsset per file and splices the
// resulting markdown into the block. This covers the error-surfacing half:
// a failed upload used to be swallowed by an empty catch with zero user
// feedback (verified failing before the fix); now it must set a visible
// uploadError and leave the block text untouched.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, stubFetch, type SyncFake } from "../test-helpers";
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
