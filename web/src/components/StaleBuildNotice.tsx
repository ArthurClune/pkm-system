// pattern: Imperative Shell
// The banner shown once the server says it serves another build: this
// bundle is a stale cached copy. Reload is the clean reload, since a plain
// one would boot the same bundle from the service worker's precache.
import { useSyncExternalStore } from "react";
import { cleanReload } from "../cleanReload";
import { isBuildStale, subscribeStaleBuild } from "../staleBuild";

export function StaleBuildNotice() {
  const stale = useSyncExternalStore(subscribeStaleBuild, isBuildStale);
  if (!stale) return null;
  return (
    <div className="ws-banner stale-build" role="status">
      A newer version of pkm is available.{" "}
      <button type="button" onClick={() => { void cleanReload(); }}>
        Reload
      </button>
    </div>
  );
}
