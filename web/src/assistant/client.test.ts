import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, defaultUnauthorizedHandler, setUnauthorizedHandler } from "../api/client";
import { closeConversationBeacon, streamMessage } from "./client";

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
  vi.useRealTimers();
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

  test("surfaces the server's detail on non-OK status (pkm-c98s item 5)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "unknown conversation" }), { status: 404 }),
    );
    const err = await streamMessage("c1", "hi", () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).detail).toBe("unknown conversation");
  });

  test("invokes the unauthorized handler and throws on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(streamMessage("c1", "hi", () => {})).rejects.toThrow("401");
    expect(handler).toHaveBeenCalledOnce();
  });

  // pkm-e9ok leg 2: the server writes a keepalive every 15s, so a full
  // minute with no bytes at all is a dead client<->server link -- which a
  // stalled fetch stream never surfaces on its own.
  test("a minute with no bytes surfaces a lost-connection error instead of hanging", async () => {
    vi.useFakeTimers();
    const silent = new ReadableStream<Uint8Array>({ start() {} }); // never emits
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(silent, { status: 200 }));
    const turn = streamMessage("c1", "hi", () => {});
    const failure = expect(turn).rejects.toThrow(/lost connection to the server/i);
    await vi.advanceTimersByTimeAsync(60_000);
    await failure;
  });

  test("the stall error is not an AbortError (Stop-button success must stay distinguishable)", async () => {
    vi.useFakeTimers();
    const silent = new ReadableStream<Uint8Array>({ start() {} });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(silent, { status: 200 }));
    const turn = streamMessage("c1", "hi", () => {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await turn;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe("AbortError");
  });

  test("any received bytes -- keepalives included -- reset the stall guard", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 200 }));
    const seen: string[] = [];
    const turn = streamMessage("c1", "hi", (ev) => seen.push(ev.type));
    // 50s gaps: each inside the window, though the turn as a whole outlives it
    await vi.advanceTimersByTimeAsync(50_000);
    controller.enqueue(encoder.encode(": keepalive\n\n"));
    await vi.advanceTimersByTimeAsync(50_000);
    controller.enqueue(encoder.encode('event: turn_done\ndata: {"usage": null}\n\n'));
    controller.close();
    await expect(turn).resolves.toBeUndefined();
    expect(seen).toEqual(["turn_done"]);
  });

  test("passes an AbortSignal through to fetch (pkm-c98s item 3: Stop button)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sseResponse(['event: turn_done\ndata: {"usage": null}\n\n']));
    const controller = new AbortController();
    await streamMessage("c1", "hi", () => {}, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assistant/conversations/c1/messages",
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("closeConversationBeacon", () => {
  test("sends a beacon to the conversation's own URL", () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon });
    closeConversationBeacon("c1");
    expect(sendBeacon).toHaveBeenCalledWith("/api/assistant/conversations/c1");
    vi.unstubAllGlobals();
  });

  test("no-ops silently when sendBeacon isn't available", () => {
    vi.stubGlobal("navigator", {});
    expect(() => closeConversationBeacon("c1")).not.toThrow();
    vi.unstubAllGlobals();
  });
});
