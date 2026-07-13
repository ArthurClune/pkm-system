import { afterEach, expect, it, vi } from "vitest";
import { ApiError, OfflineError, apiFetch, defaultUnauthorizedHandler,
         setOfflineGateway, setUnauthorizedHandler } from "./client";

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
  expect(fetchMock).toHaveBeenCalledWith("/api/x", undefined);
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
