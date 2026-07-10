// Regression coverage for pkm-falb: the op queue is connection-aware, so async
// work that resolves after the socket drops (a debounced text op, an image
// upload completion) never POSTs while offline, and preserved work flushes on
// reconnect after authoritative state is re-established.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { uploadAsset } from "./assets";
import { useOutline, type Outline } from "../outline/useOutline";
import { block, FakeWebSocket, jsonResponse, pagePayload } from "../test-helpers";
import { SyncProvider } from "./SyncProvider";

vi.mock("./assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./assets")>()),
  uploadAsset: vi.fn(),
}));
const uploadAssetMock = vi.mocked(uploadAsset);

function Harness({ initial, onReady }: {
  initial: BlockNode[];
  onReady: (o: Outline) => void;
}) {
  const outline = useOutline("Page", initial);
  useEffect(() => onReady(outline));
  return null;
}

function lastWs(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

/** POST /api/ops requests recorded on the global fetch mock, newest last. */
function opsPosts(): Array<{ ops: unknown[] }> {
  const mock = vi.mocked(fetch);
  return mock.mock.calls
    .filter(([url, init]) =>
      String(url).startsWith("/api/ops") &&
      (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)) as { ops: unknown[] });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/page/Page")) {
      return jsonResponse(pagePayload("Page",
        [block("u1", "server text", { order_idx: 0 })]));
    }
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  uploadAssetMock.mockReset();
});

function renderOutline(initial: BlockNode[]): () => Outline {
  let outline!: Outline;
  render(
    <SyncProvider>
      <Harness initial={initial} onReady={(o) => { outline = o; }} />
    </SyncProvider>);
  return () => outline;
}

test("(a) a text draft whose debounce fires after disconnect posts no op", () => {
  vi.useFakeTimers();
  const getOutline = renderOutline([block("u1", "", { order_idx: 0 })]);
  act(() => lastWs().open()); // connected

  act(() => getOutline().handlers.onFocusBlock("u1", 0));
  act(() => getOutline().handlers.onDraftChange("u1", "hello")); // 500ms timer
  act(() => lastWs().drop()); // disconnect before the debounce fires
  act(() => { vi.advanceTimersByTime(600); }); // debounce -> flush -> enqueue

  expect(opsPosts()).toHaveLength(0);
});

test("(b) an image upload completing after disconnect posts no op", async () => {
  let finishUpload!: () => void;
  uploadAssetMock.mockReturnValue(new Promise((resolve) => {
    finishUpload = () => resolve({
      sha256: "abc", filename: "pic.png", mime: "image/png",
      size: 1, url: "/assets/abc/pic.png",
    });
  }));
  const getOutline = renderOutline([block("u1", "", { order_idx: 0 })]);
  act(() => lastWs().open()); // connected

  const file = new File(["x"], "pic.png", { type: "image/png" });
  act(() => getOutline().handlers.onFiles("u1", 0, [file])); // upload starts
  act(() => lastWs().drop()); // disconnect while the upload is outstanding

  await act(async () => { finishUpload(); await Promise.resolve(); });

  expect(opsPosts()).toHaveLength(0);
});

test("(c) reconnect flushes the ops preserved while offline, in order", async () => {
  vi.useFakeTimers();
  const getOutline = renderOutline([block("u1", "", { order_idx: 0 })]);
  act(() => lastWs().open()); // first connect

  act(() => getOutline().handlers.onFocusBlock("u1", 0));
  act(() => getOutline().handlers.onDraftChange("u1", "offline edit"));
  act(() => lastWs().drop());
  act(() => { vi.advanceTimersByTime(600); }); // debounce enqueues while offline
  expect(opsPosts()).toHaveLength(0); // preserved, not sent

  act(() => { vi.advanceTimersByTime(2000); }); // socket auto-reconnect timer
  await act(async () => { lastWs().open(); }); // reconnect -> flush

  const posts = opsPosts();
  expect(posts).toHaveLength(1);
  expect(posts[0].ops).toEqual([
    { op: "update_text", uid: "u1", text: "offline edit" },
  ]);
});
