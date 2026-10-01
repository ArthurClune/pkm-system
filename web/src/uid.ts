// pattern: Imperative Shell
// Gathers the random bytes (crypto.getRandomValues is the I/O: real entropy,
// not a pure function) and hands them to uidCore's pure byte-to-alphabet
// mapping. See uidCore.ts for the alphabet/length rationale.
import { UID_BYTE_LENGTH, bytesToUid, isAlphanumericByte } from "./uidCore";
import type { BlockUid } from "./api/brands";

// The raw, unbranded minter. `ClientId` and `BatchId` (sync/opQueue.ts,
// replica/workerHandlers.ts) are uid-shaped but not block uids, so they
// mint from this rather than casting a BlockUid to a different brand.
export function newRawUid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(UID_BYTE_LENGTH));
  // Resample only the first byte until it lands on an alphanumeric
  // alphabet symbol -- mirrors the Python client/server uid
  // minters' rejection-sampling fix for the same argparse hazard.
  while (!isAlphanumericByte(bytes[0])) {
    bytes[0] = crypto.getRandomValues(new Uint8Array(1))[0];
  }
  return bytesToUid(bytes);
}

export function newUid(): BlockUid {
  return newRawUid() as BlockUid;
}
