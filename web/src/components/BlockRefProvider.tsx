// pattern: Imperative Shell
// Serves ((uid)) block-ref texts: the payload's map, plus on-demand fetches
// for uids that appear after load (a freshly pasted ref, pkm-y6af). BlockRef
// asks via BlockRefRequestContext; requests made in one render pass are
// batched into a single GET /api/block-refs call. Each uid is fetched at
// most once per mount — a uid the server doesn't know stays unresolved
// rather than refetching forever (blockRefStore.ts owns that claim).
//
// Fetched texts live in the store, not in provider state, so this component
// never re-renders on a resolve: consumers subscribe per uid through
// useBlockRefText and only the resolved ones wake. The payload map is a
// separate, near-static context value for the same reason.
import { useCallback, useRef, useState, type ReactNode } from "react";
import { apiGet } from "../api/typedClient";
import type { BlockRefText } from "../api/payloads";
import { BlockRefContext, BlockRefRequestContext,
         BlockRefStoreContext } from "../contexts";
import { createBlockRefStore } from "./blockRefStore";

// Server rejects >50 uids per request.
const CHUNK = 50;

export function BlockRefProvider({ seed, children }: {
  seed: Record<string, BlockRefText>; children: ReactNode;
}) {
  const [store] = useState(createBlockRefStore);
  const pendingRef = useRef(new Set<string>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const request = useCallback((uid: string) => {
    if (!store.claimRequest(uid)) return;
    pendingRef.current.add(uid);
    if (timerRef.current !== null) return;
    // One macrotask collects every request from the same render pass.
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const uids = [...pendingRef.current];
      pendingRef.current.clear();
      for (let i = 0; i < uids.length; i += CHUNK) {
        const batch = uids.slice(i, i + CHUNK);
        apiGet("/api/block-refs", { query: { uids: batch.join(",") } })
          .then((p) => store.resolve(p.block_ref_texts))
          .catch(() => undefined); // stays unresolved; renders as ((uid))
      }
    }, 0);
  }, [store]);

  return (
    <BlockRefStoreContext.Provider value={store}>
      <BlockRefContext.Provider value={seed}>
        <BlockRefRequestContext.Provider value={request}>
          {children}
        </BlockRefRequestContext.Provider>
      </BlockRefContext.Provider>
    </BlockRefStoreContext.Provider>
  );
}
