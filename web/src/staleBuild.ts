// pattern: Imperative Shell
// Whether the server has said it serves a build other than this bundle's.
// apiFetch reports each network response's X-Pkm-Build; StaleBuildNotice
// shows the banner. Once stale, a bundle stays stale until it reloads.
import { isStaleBuild } from "./buildSkewCore";

// Replaced at build time by tooling/buildStampPlugin.ts: this build's id,
// or "dev" under vite serve. Declared here, not in vite-env.d.ts, because
// the e2e and perf tsconfigs compile this file without that one. The
// property and perf vitest configs run without the plugin, where the name
// is undefined, so it is read through typeof and stands for "dev" there.
declare const __PKM_BUILD__: string;
const OWN_BUILD = typeof __PKM_BUILD__ === "string" ? __PKM_BUILD__ : "dev";

let stale = false;
const listeners = new Set<() => void>();

export function noteServedBuild(served: string | null,
                                own: string = OWN_BUILD): void {
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
