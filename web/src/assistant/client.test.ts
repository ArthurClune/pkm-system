import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, defaultUnauthorizedHandler, setUnauthorizedHandler } from "../api/client";
import { streamMessage } from "./client";

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setUnauthorizedHandler(defaultUnauthorizedHandler);
});

describe("streamMessage", () => {
  test("POSTs the text and forwards parsed events", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        sseResponse([
          'event: text_delta\ndata: {"text": "he"}\n\n',
          'event: text_delta\ndata: {"text": "y"}\n\nevent: turn_done\ndata: {"usage": null}\n\n',
        ]),
      );
    const seen: string[] = [];
    await streamMessage("c1", "hi", (ev) => seen.push(ev.type));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assistant/conversations/c1/messages",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
    );
    expect(seen).toEqual(["text_delta", "text_delta", "turn_done"]);
  });

  test("throws ApiError on non-OK status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(streamMessage("c1", "hi", () => {})).rejects.toBeInstanceOf(ApiError);
  });

  test("invokes the unauthorized handler and throws on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(streamMessage("c1", "hi", () => {})).rejects.toThrow("401");
    expect(handler).toHaveBeenCalledOnce();
  });
});
