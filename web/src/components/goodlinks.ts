// pattern: Functional Core
// Which hrefs are GoodLinks copies: exactly the prefix plus a 32-hex link id,
// nothing else. The renderer keys on this, never on the link text, so both
// `Local copy:: [Goodlinks](...)` and an inline `([copy in Goodlinks](...))`
// open the reader. Anything that is not an exact id falls through to the
// ordinary anchor path (a typo must not become a broken button).
const GOODLINKS_HREF_RE = /^\/api\/goodlinks\/([0-9a-f]{32})$/;

export function goodlinksIdFromHref(href: string): string | null {
  const m = GOODLINKS_HREF_RE.exec(href);
  return m ? m[1] : null;
}

export function isGoodlinksHref(href: string): boolean {
  return goodlinksIdFromHref(href) !== null;
}
