// pattern: Imperative Shell
// Serves ((uid)) block-ref texts: the payload's map, plus on-demand fetches
// for uids that appear after load (a freshly pasted ref, pkm-y6af). BlockRef
// asks via BlockRefRequestContext; requests made in one render pass are
// batched into a single GET /api/block-refs call. Each uid is fetched at
// most once per mount — a uid the server doesn't know stays unresolved
// rather than refetching forever.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "../api/client";
import type { BlockRefsPayload, BlockRefText } from "../api/payloads";
import { BlockRefContext, BlockRefRequestContext } from "../contexts";

// Server rejects >50 uids per request.
const CHUNK = 50;

export function BlockRefProvider({ seed, children }: {
  seed: Record<string, BlockRefText>; children: ReactNode;
}) {
  const [fetched, setFetched] = useState<Record<string, BlockRefText>>({});
  const requestedRef = useRef(new Set<string>());
  const pendingRef = useRef(new Set<string>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const request = useCallback((uid: string) => {
    if (requestedRef.current.has(uid)) return;
    requestedRef.current.add(uid);
    pendingRef.current.add(uid);
    if (timerRef.current !== null) return;
    // One macrotask collects every request from the same render pass.
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const uids = [...pendingRef.current];
      pendingRef.current.clear();
      for (let i = 0; i < uids.length; i += CHUNK) {
        const batch = uids.slice(i, i + CHUNK);
        apiFetch<BlockRefsPayload>(`/api/block-refs?uids=${batch.join(",")}`)
          .then((p) => setFetched((m) => ({ ...m, ...p.block_ref_texts })))
          .catch(() => undefined); // stays unresolved; renders as ((uid))
      }
    }, 0);
  }, []);

  // Payload entries win: they are the authoritative, freshest state.
  const value = useMemo(() => ({ ...fetched, ...seed }), [fetched, seed]);
  return (
    <BlockRefContext.Provider value={value}>
      <BlockRefRequestContext.Provider value={request}>
        {children}
      </BlockRefRequestContext.Provider>
    </BlockRefContext.Provider>
  );
}
