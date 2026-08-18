// pattern: Imperative Shell
// The stale-response guard shared by surfaces that keep at most ONE request
// live at a time (pkm-kk0t): a debounced search, a title-completion popup, a
// query block re-fetching for a new expression. Every dispatch calls
// begin(); everything the response wants to commit is gated on
// !isStale(token), so a slow answer for an old input can never overwrite a
// newer one -- true even when the offline gateway ignores an AbortController
// and the request really does resolve.
//
// Two operations, deliberately distinct:
//   begin()  -- start a request, invalidating whatever was live
//   cancel() -- invalidate whatever was live WITHOUT starting anything
// cancel() is what a cleared query or a dismissed surface needs: without it
// the in-flight response would still be current and would repopulate a
// surface the user has just emptied.
//
// This is NOT the right shape for a guard whose generation spans SEVERAL
// concurrent requests that must all stay valid together (Files' filter
// generation, where loadMore and selectAll join the generation reload
// started rather than beginning their own) -- that contract has no single
// live token, so it keeps its own helpers.
import { useRef, useState } from "react";

export interface StaleGuard {
  /** Starts a request: invalidates any live token and returns the new one. */
  begin: () => number;
  /** Invalidates the live token without starting a request. */
  cancel: () => void;
  /** True once `token` has been superseded by a begin() or a cancel(). */
  isStale: (token: number) => boolean;
}

export function useStaleGuard(): StaleGuard {
  const seq = useRef(0);
  // Built once and never replaced, so it is safe in an effect's dependency
  // array; the mutable sequence lives in the ref, not in this object.
  const [guard] = useState<StaleGuard>(() => ({
    begin: () => ++seq.current,
    cancel: () => { seq.current++; },
    isStale: (token: number) => token !== seq.current,
  }));
  return guard;
}
