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
    .map(decodeURIComponent)
    .join("/");
}
