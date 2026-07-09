// pattern: Functional Core
// 16 chars from a 64-symbol alphabet (uniform: 64 divides 256) via
// crypto.getRandomValues — matches the server's ^[a-zA-Z0-9_-]{6,32}$ and
// the spec's "new = nanoid" without a dependency. ~96 bits of entropy.
const ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

export function newUid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 63];
  return out;
}
