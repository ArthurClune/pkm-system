import { afterEach, expect, it, vi } from "vitest";
import { ApiError, apiFetch, defaultUnauthorizedHandler, setUnauthorizedHandler } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(defaultUnauthorizedHandler);
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
