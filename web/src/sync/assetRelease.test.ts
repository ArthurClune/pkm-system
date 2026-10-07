import { afterEach, expect, test, vi } from "vitest";
import type { Sha256Hex } from "../api/brands";
import { releaseAssets, releaseOnUnload, releaseUrl } from "./assetRelease";
import type { DeliveryOutcome } from "./opQueue";

const A = "aa".repeat(32) as Sha256Hex;
const B = "bb".repeat(32) as Sha256Hex;
const delivered: DeliveryOutcome = { status: "delivered" };

function fetchReturning(status: number) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response("{}", { status }));
}

afterEach(() => vi.restoreAllMocks());

test("releaseUrl names the conditional delete", () => {
  expect(releaseUrl(A)).toBe(`/api/assets/${A}?if_unreferenced=true`);
});

test("releaseAssets waits for deliveries, then deletes each sha in order", async () => {
  const doFetch = fetchReturning(200);
  let resolve!: (o: DeliveryOutcome) => void;
  const pending = new Promise<DeliveryOutcome>((r) => { resolve = r; });
  const done = releaseAssets([A, B], [pending], doFetch as unknown as typeof fetch);
  await Promise.resolve();
  expect(doFetch).not.toHaveBeenCalled();
  resolve(delivered);
  await done;
  expect(doFetch.mock.calls.map((c) => c[0])).toEqual([releaseUrl(A), releaseUrl(B)]);
  expect(doFetch.mock.calls[0][1]).toMatchObject({ method: "DELETE", credentials: "same-origin" });
});

test("a failed delivery means nothing is fetched", async () => {
  const doFetch = fetchReturning(200);
  await releaseAssets([A], [Promise.resolve(delivered),
    Promise.resolve<DeliveryOutcome>({ status: "failed", error: new Error("x") })],
    doFetch as unknown as typeof fetch);
  expect(doFetch).not.toHaveBeenCalled();
});

test("409 and 404 are final and silent", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const status of [409, 404]) {
    await releaseAssets([A], [], fetchReturning(status) as unknown as typeof fetch);
  }
  expect(warn).not.toHaveBeenCalled();
});

test("a 500 and a network error are warned about, never thrown", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await releaseAssets([A], [], fetchReturning(500) as unknown as typeof fetch);
  expect(warn).toHaveBeenCalledTimes(1);
  const boom = vi.fn(async () => { throw new Error("offline"); });
  await releaseAssets([A], [], boom as unknown as typeof fetch);
  expect(warn).toHaveBeenCalledTimes(2);
});

test("releaseOnUnload sends keepalive deletes and swallows errors", () => {
  const doFetch = fetchReturning(200);
  releaseOnUnload([A, B], doFetch as unknown as typeof fetch);
  expect(doFetch).toHaveBeenCalledTimes(2);
  expect(doFetch.mock.calls[1][1]).toMatchObject({ method: "DELETE", keepalive: true });
  const sync = vi.fn(() => { throw new Error("sync"); });
  expect(() => releaseOnUnload([A], sync as unknown as typeof fetch)).not.toThrow();
  const rejecting = vi.fn(async () => { throw new Error("async"); });
  expect(() => releaseOnUnload([A], rejecting as unknown as typeof fetch)).not.toThrow();
});

test("keep vetoes a sha at fetch time, not at schedule time", async () => {
  const doFetch = fetchReturning(200);
  let resolve!: (o: DeliveryOutcome) => void;
  const pending = new Promise<DeliveryOutcome>((r) => { resolve = r; });
  const kept = new Set<Sha256Hex>();
  const done = releaseAssets([A, B], [pending], doFetch as unknown as typeof fetch,
                             (sha) => kept.has(sha));
  kept.add(A);
  resolve(delivered);
  await done;
  expect(doFetch.mock.calls.map((c) => c[0])).toEqual([releaseUrl(B)]);
});
