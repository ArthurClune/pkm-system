// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, OfflineError, StalledReadError, apiFetch,
         setOfflineGateway } from "./client";

/** A fetch that honours its signal like the real one, answering with a body
 * the test feeds chunk by chunk; the headers arrive after `headersAfterMs`. */
function feedableFetch(headersAfterMs = 0) {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) { feed = c; },
  });
  const fetchMock = vi.fn((_path: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort);
      const answer = () => resolve(new Response(body, { status: 200 }));
      if (headersAfterMs === 0) answer();
      else setTimeout(answer, headersAfterMs);
    }));
  return {
    fetchMock,
    push: (text: string) => feed.enqueue(encoder.encode(text)),
    end: () => feed.close(),
  };
}

/** A fetch that never answers, rejecting only when its signal aborts. */
function silentFetch() {
  return vi.fn((_path: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")));
    }));
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setOfflineGateway(null);
});

describe("a stall-bounded read", () => {
  it("fails with StalledReadError when no byte arrives for stallMs",
    async () => {
      vi.stubGlobal("fetch", silentFetch());
      const result = apiFetch("/api/x", undefined, { stallMs: 30_000 })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toBeInstanceOf(StalledReadError);
    });

  it("each chunk restarts the stall clock, so a body slower than stallMs "
    + "in total completes", async () => {
    const { fetchMock, push, end } = feedableFetch();
    vi.stubGlobal("fetch", fetchMock);
    const result = apiFetch<{ n: number }>(
      "/api/x", undefined, { stallMs: 1000, timeoutMs: null });
    await vi.advanceTimersByTimeAsync(900);
    push('{"n"');
    await vi.advanceTimersByTimeAsync(900);
    push(":1");
    await vi.advanceTimersByTimeAsync(900);
    push("}");
    end();
    await expect(result).resolves.toEqual({ n: 1 });
  });

  it("the headers restart the stall clock, so a first chunk within stallMs "
    + "of late headers completes", async () => {
    const { fetchMock, push, end } = feedableFetch(900);
    vi.stubGlobal("fetch", fetchMock);
    const result = apiFetch<{ n: number }>("/api/x", undefined,
      { stallMs: 1000, timeoutMs: null }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1500);
    push('{"n":1}');
    end();
    expect(await result).toEqual({ n: 1 });
  });

  it("a body that goes silent part-way fails with StalledReadError",
    async () => {
      const { fetchMock, push } = feedableFetch();
      vi.stubGlobal("fetch", fetchMock);
      const result = apiFetch("/api/x", undefined,
        { stallMs: 1000, timeoutMs: null }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(500);
      push('{"n"');
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toBeInstanceOf(StalledReadError);
    });

  it("onProgress runs once per chunk received", async () => {
    const { fetchMock, push, end } = feedableFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();
    const result = apiFetch("/api/x", undefined,
      { stallMs: 1000, timeoutMs: null, onProgress });
    await vi.advanceTimersByTimeAsync(10);
    push('{"a":');
    await vi.advanceTimersByTimeAsync(10);
    expect(onProgress).toHaveBeenCalledTimes(1);
    push("1}");
    await vi.advanceTimersByTimeAsync(10);
    expect(onProgress).toHaveBeenCalledTimes(2);
    end();
    await result;
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("a stall before the headers stays a StalledReadError with the "
    + "offline gateway installed", async () => {
    vi.stubGlobal("fetch", silentFetch());
    const handle = vi.fn(() => Promise.resolve({ handled: false }));
    setOfflineGateway({ offline: () => false, handle });
    const result = apiFetch("/api/x", undefined, { stallMs: 30_000 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await result;
    expect(err).toBeInstanceOf(StalledReadError);
    expect(err).not.toBeInstanceOf(OfflineError);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(handle).not.toHaveBeenCalled();
  });

  it("a slow offline-gateway fallback keeps its own outcome after stallMs",
    async () => {
      vi.stubGlobal("fetch", vi.fn(() =>
        Promise.reject(new TypeError("network down"))));
      const handle = vi.fn(() => new Promise<{ handled: false }>((resolve) => {
        setTimeout(() => resolve({ handled: false }), 2000);
      }));
      setOfflineGateway({ offline: () => false, handle });
      const result = apiFetch("/api/x", undefined, { stallMs: 1000 })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await result).toBeInstanceOf(OfflineError);
    });

  it("a caller's own signal still aborts a stall-bounded read", async () => {
    vi.stubGlobal("fetch", silentFetch());
    const own = new AbortController();
    const result = apiFetch("/api/x", { signal: own.signal },
      { stallMs: 30_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    own.abort();
    const err = await result;
    expect(err).not.toBeInstanceOf(StalledReadError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("StalledReadError's message names the silence in seconds", () => {
    expect(new StalledReadError(30_000).message)
      .toBe("no data from the server for 30 seconds");
  });
});
