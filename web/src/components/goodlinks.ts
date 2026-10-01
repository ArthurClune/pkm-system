// pattern: Functional Core
// Which hrefs are GoodLinks copies: exactly the prefix plus a 32-hex link id,
// nothing else. InlineSegments extracts the id once and passes it down, so
// GoodlinksLink and GoodlinksReader never re-parse the href themselves.
// Anything that is not an exact id falls through to the ordinary anchor path
// (a typo must not become a broken button).
import type { GoodlinksId } from "../api/brands";

const GOODLINKS_HREF_RE = /^\/api\/goodlinks\/([0-9a-f]{32})$/;

// The one place a web href's id is checked against GoodLinks' shape and
// becomes a GoodlinksId.
export function goodlinksIdFromHref(href: string): GoodlinksId | null {
  const m = GOODLINKS_HREF_RE.exec(href);
  return m ? m[1] as GoodlinksId : null;
}

// The server's 503 detail for a refused API token. The reader and the
// /goodlinks notice each word the ordinary 503 ("not running") their own
// way, and show only this one detail exactly as the server sent it.
export const UNAUTHORIZED_DETAIL = "Goodlinks rejected the API token";
