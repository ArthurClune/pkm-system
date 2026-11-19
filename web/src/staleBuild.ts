// pattern: Imperative Shell
// Whether the server has said it serves a build other than this bundle's.
// apiFetch reports each network response's X-Pkm-Build; StaleBuildNotice
// shows the banner. Once stale, a bundle stays stale until it reloads.
import { isStaleBuild } from "./buildSkewCore";

// Replaced at build time by tooling/buildStampPlugin.ts: this build's id,
// or "dev" under vite serve. Declared here, not in vite-env.d.ts, because
// the e2e and perf tsconfigs compile this file without that one.
declare const __PKM_BUILD__: string;

let stale = false;
const listeners = new Set<() => void>();

export function noteServedBuild(served: string | null,
                                own: string = __PKM_BUILD__): void {
  if (stale || !isStaleBuild(own, served)) return;
  stale = true;
  listeners.forEach((l) => l());
}

export function isBuildStale(): boolean {
  return stale;
}

export function subscribeStaleBuild(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: the stale flag is module state. */
export function resetStaleBuild(): void {
  stale = false;
}
