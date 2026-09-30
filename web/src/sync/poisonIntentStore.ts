// pattern: Imperative Shell
// localStorage persistence for poison-mark intents, so a reload still marks
// a batch the server rejected before the replica recorded it.
import { parseStoredIntents, serialiseIntents,
         type PoisonEvent } from "./poisonIntents";

const POISON_MARK_INTENTS_KEY = "pkm.poison-mark-intents.v1";

export function readPoisonMarkIntents(): PoisonEvent[] {
  try {
    return parseStoredIntents(
      globalThis.localStorage?.getItem(POISON_MARK_INTENTS_KEY));
  } catch {
    // localStorage can be unavailable.
    return [];
  }
}

export function writePoisonMarkIntents(intents: readonly PoisonEvent[]): void {
  try {
    if (intents.length === 0) {
      globalThis.localStorage?.removeItem(POISON_MARK_INTENTS_KEY);
    } else {
      globalThis.localStorage?.setItem(
        POISON_MARK_INTENTS_KEY, serialiseIntents(intents));
    }
  } catch {
    // The in-memory barrier still protects this page. A stale durable intent
    // is safe: startup retries marking idempotently before delivery.
  }
}
