// pattern: Imperative Shell
// A reload that escapes a stale precached bundle: drop the service worker
// and Cache Storage, then load / from the network. It never touches OPFS or
// IndexedDB, where the replica keeps unsynced edits. It runs only once
// /healthz answers, because with the service worker gone and no network
// nothing would boot; unreachable, it falls back to a plain reload.

async function serverReachable(): Promise<boolean> {
  try {
    return (await fetch("/healthz", { cache: "no-store" })).ok;
  } catch {
    return false;
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
