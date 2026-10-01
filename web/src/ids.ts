// pattern: Functional Core
// Validates an untrusted string against a block uid's shape, the one place
// outside grammar/scan.ts's own token match that turns a raw string into a
// BlockUid -- used where a uid arrives unparsed, such as a URL hash.
import { UID_TOKEN } from "./grammar/scan";
import type { BlockUid } from "./api/brands";

const FULL_UID_RE = new RegExp(`^${UID_TOKEN}$`);

export function parseBlockUid(raw: string): BlockUid | null {
  return FULL_UID_RE.test(raw) ? (raw as BlockUid) : null;
}
