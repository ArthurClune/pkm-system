import { afterEach, expect, it, vi } from "vitest";
import { apiDownload, apiFetch, defaultUnauthorizedHandler, setOfflineGateway,
         setUnauthorizedHandler } from "./client";
import { noteServedBuild } from "../staleBuild";

vi.mock("../staleBuild", () => ({ noteServedBuild: vi.fn() }));

function stamped(status: number): Response {
  return new Response("{}", {
    status,
    headers: { "Content-Type": "application/json", "X-Pkm-Build": "other" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(noteServedBuild).mockClear();
  setUnauthorizedHandler(defaultUnauthorizedHandler);
  setOfflineGateway(null);
});

it("passes a response's served build to the stale-build store", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stamped(200)));
  await apiFetch("/api/x");
  expect(noteServedBuild).toHaveBeenCalledWith("other");
});

it("notes the build on a 401 too, before the login redirect", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stamped(401)));
  setUnauthorizedHandler(() => undefined);
  await apiFetch("/api/x").catch(() => undefined);
  expect(noteServedBuild).toHaveBeenCalledWith("other");
});

it("notes the build on a download", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stamped(200)));
  await apiDownload("/api/x");
  expect(noteServedBuild).toHaveBeenCalledWith("other");
});

it("never compares a replica shim response", async () => {
  setOfflineGateway({
    offline: () => true,
    handle: async () => ({ handled: true, status: 200, body: {} }),
  });
  await apiFetch("/api/page/X");
  expect(noteServedBuild).not.toHaveBeenCalled();
});

it("never compares the shim fallback after a failed fetch", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed")));
  setOfflineGateway({
    offline: () => false,
    handle: async () => ({ handled: true, status: 200, body: {} }),
  });
  await apiFetch("/api/page/X");
  expect(noteServedBuild).not.toHaveBeenCalled();
});
