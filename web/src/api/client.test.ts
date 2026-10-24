import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, OfflineError, READ_TIMEOUT_MS, apiDownload, apiFetch,
         defaultUnauthorizedHandler, deleteRefusalBlockers,
         setOfflineGateway, setUnauthorizedHandler } from "./client";
import { canonicalTitleOf, uidOf } from "../test-helpers";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(defaultUnauthorizedHandler);
  setOfflineGateway(null);
});

it("returns parsed json", async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(apiFetch<{ ok: boolean }>("/api/x")).resolves.toEqual({ ok: true });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/x");
  // reads carry the read timeout, and nothing else
  expect(Object.keys(init)).toEqual(["signal"]);
});

it("invokes the unauthorized handler and throws on 401", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: "no" }, 401)));
  const redirect = vi.fn();
  setUnauthorizedHandler(redirect);
  await expect(apiFetch("/api/x")).rejects.toThrow("401");
  expect(redirect).toHaveBeenCalledOnce();
});

it("throws ApiError carrying the status on other failures", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: "nope" }, 404)));
  const err = await apiFetch("/api/x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(404);
});

it("surfaces the server's detail message on ApiError", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(jsonResponse({ detail: "at most 3 concurrent conversations" }, 409)),
  );
  const err = await apiFetch("/api/assistant/conversations").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).detail).toBe("at most 3 concurrent conversations");
  expect((err as ApiError).message).toContain("at most 3 concurrent conversations");
});

it("keeps a structured error body, whose detail is no string", async () => {
  const body = { detail: { message: "blocked", blockers: [] } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, 409)));
  const err = await apiFetch("/api/x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).detail).toBeUndefined();
  expect((err as ApiError).body).toEqual(body);
});

it("leaves detail undefined when the error body isn't JSON with a detail field", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("plain text", { status: 500 })));
  const err = await apiFetch("/api/x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).detail).toBeUndefined();
});

it("serves from the offline gateway without touching the network", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setOfflineGateway({
    offline: () => true,
    handle: async () => ({ handled: true, status: 200, body: { local: true } }),
  });
  await expect(apiFetch("/api/page/X")).resolves.toEqual({ local: true });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("throws OfflineError for routes the shim does not serve", async () => {
  setOfflineGateway({
    offline: () => true,
    handle: async () => ({ handled: false }),
  });
  const err = await apiFetch("/api/query?expr=x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(OfflineError);
  expect((err as OfflineError).message).toMatch(/unavailable without a connection/);
});

it("maps shim error statuses to ApiError", async () => {
  setOfflineGateway({
    offline: () => true,
    handle: async () => ({ handled: true, status: 404, body: { detail: "no" } }),
  });
  const err = await apiFetch("/api/page/Missing").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).not.toBeInstanceOf(OfflineError);
  expect((err as ApiError).status).toBe(404);
  expect((err as ApiError).detail).toBe("no");
});

it("falls back to the shim when fetch fails before the socket notices", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  setOfflineGateway({
    offline: () => false, // status lags the dropped network
    handle: async () => ({ handled: true, status: 200, body: { local: true } }),
  });
  await expect(apiFetch("/api/page/X")).resolves.toEqual({ local: true });
});

it("rethrows fetch failures when no gateway is installed", async () => {
  const boom = new TypeError("Failed to fetch");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(boom));
  await expect(apiFetch("/api/x")).rejects.toBe(boom);
});

/** A fetch that only ever settles by abort, so the test observes exactly what
 * the caller's signal does — the real one rejects with the signal's reason. */
function abortOnlyFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_ok, reject) => {
    init?.signal?.addEventListener("abort", () => { reject(init.signal?.reason); });
  }));
}

it("aborts a read that outlives the read timeout", async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal("fetch", abortOnlyFetch());
    const pending = apiFetch("/api/sync/changes?since=0").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(await Promise.race([pending, "still waiting"])).toBe("still waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending as Error).name).toBe("TimeoutError");
  } finally {
    vi.useRealTimers();
  }
});

it("leaves mutations untimed: an aborted-but-applied write is worse than a slow one", async () => {
  vi.useFakeTimers();
  try {
    const fetchMock = abortOnlyFetch();
    vi.stubGlobal("fetch", fetchMock);
    const pending = apiFetch("/api/ops", { method: "POST", body: "{}" })
      .catch((e: unknown) => e);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10 * READ_TIMEOUT_MS);
    expect(await Promise.race([pending, "still waiting"])).toBe("still waiting");
  } finally {
    vi.useRealTimers();
  }
});

it("leaves an opted-out read untimed however long it runs", async () => {
  vi.useFakeTimers();
  try {
    const fetchMock = abortOnlyFetch();
    vi.stubGlobal("fetch", fetchMock);
    const pending = apiFetch("/api/sync/snapshot", undefined, { timeoutMs: null })
      .catch((e: unknown) => e);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(init?.signal).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100 * READ_TIMEOUT_MS);
    expect(await Promise.race([pending, "still waiting"])).toBe("still waiting");
  } finally {
    vi.useRealTimers();
  }
});

it("honours a caller's own read deadline in place of the default", async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal("fetch", abortOnlyFetch());
    const pending = apiFetch("/api/x", undefined, { timeoutMs: 500 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(499);
    expect(await Promise.race([pending, "still waiting"])).toBe("still waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending as Error).name).toBe("TimeoutError");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a caller's own signal working alongside the read timeout", async () => {
  vi.stubGlobal("fetch", abortOnlyFetch());
  const controller = new AbortController();
  const pending = apiFetch("/api/x", { signal: controller.signal })
    .catch((e: unknown) => e);
  controller.abort(new Error("caller gave up"));
  expect((await pending as Error).message).toBe("caller gave up");
});

function markdownResponse(disposition: string | null): Response {
  const headers: Record<string, string> = { "Content-Type": "text/markdown" };
  if (disposition !== null) headers["Content-Disposition"] = disposition;
  return new Response("# hi", { status: 200, headers });
}

it("apiDownload returns the blob and the decoded filename*", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(markdownResponse(
    `attachment; filename="_.md"; filename*=UTF-8''%E6%97%A5.md`)));
  const { blob, filename } = await apiDownload("/api/export/page/x");
  expect(blob.size).toBe(4);
  expect(filename).toBe("日.md");
});

it("apiDownload falls back to filename, then to undefined", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    markdownResponse('attachment; filename="plain.md"')));
  expect((await apiDownload("/api/x")).filename).toBe("plain.md");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(markdownResponse(null)));
  expect((await apiDownload("/api/x")).filename).toBeUndefined();
});

it("apiDownload throws ApiError carrying the 422 detail", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    jsonResponse({ detail: "page too large" }, 422)));
  const err = await apiDownload("/api/x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(422);
  expect((err as ApiError).detail).toBe("page too large");
});

it("apiDownload calls the unauthorized handler on 401", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: "no" }, 401)));
  const redirect = vi.fn();
  setUnauthorizedHandler(redirect);
  await expect(apiDownload("/api/x")).rejects.toThrow("401");
  expect(redirect).toHaveBeenCalledOnce();
});

it("apiDownload throws OfflineError without fetching when offline", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setOfflineGateway({ offline: () => true, handle: async () => ({ handled: false }) });
  await expect(apiDownload("/api/x")).rejects.toBeInstanceOf(OfflineError);
  expect(fetchMock).not.toHaveBeenCalled();
});

describe("deleteRefusalBlockers", () => {
  const blocker = {
    uid: uidOf("tuid-b1"), page_title: canonicalTitleOf("AI"),
    text: "[x]", reason: "limit" as const,
  };
  const refusal = (body: unknown, status = 409) =>
    new ApiError(status, "/api/assets/x", undefined, body);

  it("reads the blocks a delete's 409 names", () => {
    expect(deleteRefusalBlockers(
      refusal({ detail: { message: "m", blockers: [blocker] } })))
      .toEqual([blocker]);
  });

  it("finds none in another error, status or body", () => {
    expect(deleteRefusalBlockers(new Error("x"))).toBeNull();
    expect(deleteRefusalBlockers(
      refusal({ detail: { blockers: [blocker] } }, 422))).toBeNull();
    expect(deleteRefusalBlockers(
      refusal({ detail: "asset is referenced" }))).toBeNull();
    expect(deleteRefusalBlockers(refusal(undefined))).toBeNull();
    expect(deleteRefusalBlockers(
      refusal({ detail: { blockers: [] } }))).toBeNull();
    expect(deleteRefusalBlockers(
      refusal({ detail: { blockers: [{ uid: 1 }] } }))).toBeNull();
  });
});
