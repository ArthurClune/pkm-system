// pattern: Functional Core
// Titles may contain "/" (namespace pages): encode per segment so the slash
// stays literal for the server's path-typed {title:path} routes.

export function encodeTitle(title: string): string {
  return title.split("/").map(encodeURIComponent).join("/");
}

export function pagePath(title: string): string {
  return `/page/${encodeTitle(title)}`;
}

export function titleFromPathname(pathname: string): string {
  return pathname
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
    .join("/");
}
