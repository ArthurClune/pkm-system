import { afterEach, expect, it, vi } from "vitest";
import { HEALTH_PROBE_TIMEOUT_MS, cleanReload } from "./cleanReload";

afterEach(() => vi.unstubAllGlobals());

interface Stubs {
  health?: (url: string, init?: RequestInit) => Promise<Response>;
  unregister?: () => Promise<boolean>;
  deleteCache?: (name: string) => Promise<boolean>;
  serviceWorker?: boolean;
}

function stub({ health = async () => new Response("ok"),
                unregister = async () => true,
                deleteCache = async () => true,
                serviceWorker = true }: Stubs = {}) {
  const fetchMock = vi.fn(health);
  const unregisterMock = vi.fn(unregister);
  const deleteMock = vi.fn(deleteCache);
  const location = { assign: vi.fn(), reload: vi.fn() };
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", location);
  vi.stubGlobal("caches", {
    keys: async () => ["workbox-precache-v2", "pkm-assets"],
    delete: deleteMock,
  });
  vi.stubGlobal("navigator", {
    ...navigator,
    serviceWorker: serviceWorker
      ? { getRegistrations: async () => [{ unregister: unregisterMock },
                                          { unregister: unregisterMock }] }
      : undefined,
  });
  return { fetchMock, unregisterMock, deleteMock, location };
}

it("with the server up, drops the service worker and caches, then loads /",
   async () => {
  const s = stub();
  await cleanReload();
  expect(s.fetchMock).toHaveBeenCalledWith(
    "/healthz", expect.objectContaining({ cache: "no-store" }));
  expect(s.unregisterMock).toHaveBeenCalledTimes(2);
  expect(s.deleteMock.mock.calls.map((c) => c[0]))
    .toEqual(["workbox-precache-v2", "pkm-assets"]);
  expect(s.location.assign).toHaveBeenCalledWith("/");
  expect(s.location.reload).not.toHaveBeenCalled();
});

it("with the server unreachable, only reloads, keeping the offline shell",
   async () => {
  const s = stub({ health: async () => { throw new TypeError("Failed"); } });
  await cleanReload();
  expect(s.unregisterMock).not.toHaveBeenCalled();
  expect(s.deleteMock).not.toHaveBeenCalled();
  expect(s.location.assign).not.toHaveBeenCalled();
  expect(s.location.reload).toHaveBeenCalledOnce();
});

it("with the server answering an error, only reloads", async () => {
  const s = stub({ health: async () => new Response("", { status: 502 }) });
  await cleanReload();
  expect(s.unregisterMock).not.toHaveBeenCalled();
  expect(s.deleteMock).not.toHaveBeenCalled();
  expect(s.location.reload).toHaveBeenCalledOnce();
});

it("still loads / when unregistering and deleting fail", async () => {
  const s = stub({
    unregister: async () => { throw new Error("no"); },
    deleteCache: async () => { throw new Error("no"); },
  });
  await cleanReload();
  expect(s.location.assign).toHaveBeenCalledWith("/");
});

it("without the service worker API, still clears caches and loads /",
   async () => {
  const s = stub({ serviceWorker: false });
  await cleanReload();
  expect(s.deleteMock).toHaveBeenCalledTimes(2);
  expect(s.location.assign).toHaveBeenCalledWith("/");
});

it("treats a health probe that never answers as unreachable", async () => {
  vi.useFakeTimers();
  try {
    // settles only when the probe's own signal aborts it
    const s = stub({
      health: (_url, init) => new Promise<Response>((_ok, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      }),
    });
    const done = cleanReload();
    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS);
    await done;
    expect(s.location.reload).toHaveBeenCalledOnce();
    expect(s.unregisterMock).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
