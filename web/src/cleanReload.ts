// pattern: Imperative Shell
// A reload that escapes a stale precached bundle: drop the service worker
// and Cache Storage, then load / from the network. It never touches OPFS or
// IndexedDB, where the replica keeps unsynced edits. It runs only once
// /healthz answers, because with the service worker gone and no network
// nothing would boot; unreachable, it falls back to a plain reload.

/** How long the probe waits: a host that drops packets can hold a fetch
 * for a minute, and Reload must not look dead meanwhile. */
export const HEALTH_PROBE_TIMEOUT_MS = 4000;

async function serverReachable(): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    return (await fetch("/healthz",
                        { cache: "no-store", signal: abort.signal })).ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function dropServiceWorkers(): Promise<void> {
  // undefined outside a secure context
  const container = navigator.serviceWorker as ServiceWorkerContainer | undefined;
  if (!container) return;
  const registrations = await container.getRegistrations();
  await Promise.allSettled(registrations.map((r) => r.unregister()));
}

async function dropCaches(): Promise<void> {
  const names = await caches.keys();
  await Promise.allSettled(names.map((n) => caches.delete(n)));
}

export async function cleanReload(): Promise<void> {
  if (!(await serverReachable())) {
    location.reload();
    return;
  }
  await Promise.allSettled([dropServiceWorkers(), dropCaches()]);
  location.assign("/");
}
