// pattern: Imperative Shell
// Conditional server delete of uploaded files whose last reference was undone.
// Plain fetch, not apiFetch: the offline shim has no asset routes.
import type { Sha256Hex } from "../api/brands";
import type { DeliveryOutcome } from "./opQueue";

export function releaseUrl(sha: Sha256Hex): string {
  return `/api/assets/${sha}?if_unreferenced=true`;
}

// 200, 404 and 409 are final answers; anything else is logged and dropped.
export async function releaseAssets(
  shas: readonly Sha256Hex[],
  waitFor: readonly Promise<DeliveryOutcome>[],
  doFetch: typeof fetch = fetch,
): Promise<void> {
  const outcomes = await Promise.all(waitFor);
  if (outcomes.some((o) => o.status === "failed")) return;
  for (const sha of shas) {
    try {
      const res = await doFetch(releaseUrl(sha),
        { method: "DELETE", credentials: "same-origin" });
      if (![200, 404, 409].includes(res.status)) {
        console.warn(`asset release ${sha} answered ${res.status}`);
      }
    } catch (err) {
      console.warn(`asset release ${sha} failed`, err);
    }
  }
}
