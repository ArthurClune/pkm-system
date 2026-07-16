// pattern: Functional Core
// Pure byte-to-alphabet mapping for uid.ts's newUid(): each random byte
// selects one of 64 alphabet characters via a uniform 6-bit slice (64
// divides 256, so every character is equally likely). Isolated here so the
// mapping itself is deterministic and testable without touching
// crypto.getRandomValues, which stays in uid.ts's Imperative Shell.

// Matches the server's ^[a-zA-Z0-9_-]{6,32}$ and the spec's "new = nanoid"
// without a dependency.
export const UID_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

// 16 chars from the 64-symbol alphabet above: ~96 bits of entropy.
export const UID_BYTE_LENGTH = 16;

export function bytesToUid(bytes: ArrayLike<number>): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += UID_ALPHABET[bytes[i] & 63];
  return out;
}
