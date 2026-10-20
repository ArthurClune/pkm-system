// pattern: Functional Core
// Titles may contain "/" (namespace pages): encode per segment so the slash
// stays literal for the server's path-typed {title:path} routes.

import type { RawTitle } from "./api/brands";
import { asRawTitle } from "./replica/titles";
import { PAGE_ROUTE_PREFIX } from "./routeMeta";

/** Each `/`-separated segment percent-encoded, the slashes kept literal. */
export function encodePathSegments(text: string): string {
  return text.split("/").map(encodeURIComponent).join("/");
}

export function encodeTitle(title: RawTitle): string {
  return encodePathSegments(title);
}

export function pagePath(title: RawTitle): string {
  return `${PAGE_ROUTE_PREFIX}${encodeTitle(title)}`;
}

export function titleFromPathname(pathname: string): RawTitle {
  return asRawTitle(pathname
    .replace(/^\/page\//, "")
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // Malformed percent-encoding (e.g. a hand-typed "/page/100%") would
        // otherwise throw a URIError during render; fall back to the raw
        // segment rather than crashing the whole app.
        return segment;
      }
    })
    .join("/"));
}
