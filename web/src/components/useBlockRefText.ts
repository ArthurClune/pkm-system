// pattern: Imperative Shell
// The one way to read a ((uid))'s resolved text. Two channels, in
// precedence order: whatever arrived with a payload (BlockRefContext,
// including a BacklinksSection overlay) wins, and BlockRefProvider's
// on-demand fetches fill the rest.
//
// The second channel is subscribed per uid, so a resolved batch re-renders
// only the refs it resolved.
import { useCallback, useContext, useSyncExternalStore } from "react";
import type { BlockRefText } from "../api/payloads";
import { BlockRefContext, BlockRefStoreContext } from "../contexts";

export function useBlockRefText(uid: string): BlockRefText | undefined {
  const payload = useContext(BlockRefContext);
  const store = useContext(BlockRefStoreContext);
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(uid, onChange), [store, uid]);
  const getSnapshot = useCallback(() => store.get(uid), [store, uid]);
  const fetched = useSyncExternalStore(subscribe, getSnapshot);
  return payload[uid] ?? fetched;
}
