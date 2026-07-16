// pattern: Imperative Shell
// Gathers the random bytes (crypto.getRandomValues is the I/O: real entropy,
// not a pure function) and hands them to uidCore's pure byte-to-alphabet
// mapping. See uidCore.ts for the alphabet/length rationale.
import { UID_BYTE_LENGTH, bytesToUid } from "./uidCore";

export function newUid(): string {
  return bytesToUid(crypto.getRandomValues(new Uint8Array(UID_BYTE_LENGTH)));
}
