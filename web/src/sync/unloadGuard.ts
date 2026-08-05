// pattern: Imperative Shell
// beforeunload is the only hook a browser gives before a reload or tab close
// discards whatever is still stranded in opQueue's in-memory fallback lane
// (pkm-0htf). Registration is conditional on unsentInMemory > 0, not
// unconditional-with-an-early-return-inside, because a beforeunload listener
// that stays attached for the page's whole life disables the back/forward
// cache — Chrome and Firefox both opt a page out of bfcache the moment one is
// registered, regardless of what the handler itself decides to do.
//
// This is a desktop-only protection. beforeunload is unreliable in an iOS
// standalone PWA — the same sandboxing that suppresses window.confirm there
// (see useConfirm) — so this guard must not be described as covering the
// hazard everywhere; OfflineIndicator's own Reload confirm exists precisely
// because this does not hold on iPad.
import { useEffect } from "react";

export function useUnloadGuard(unsentInMemory: number): void {
  // Only whether there is anything to lose, not how much: depending on the
  // count itself would detach and reattach the listener on every op.
  const armed = unsentInMemory > 0;
  useEffect(() => {
    if (!armed) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Legacy signal some browsers still require instead of preventDefault.
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => { window.removeEventListener("beforeunload", onBeforeUnload); };
  }, [armed]);
}
