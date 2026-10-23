// pattern: Functional Core
// Which media the app may fetch on render, and how a placeholder names the
// rest. Only uploaded assets (same-origin /assets/ paths) load unprompted;
// any other src, data: and blob: included, is external.

// A path that climbs out of its prefix names another same-origin route:
// /assets/../api/export.zip would run an export on render. The URL parser
// drops tabs and newlines anywhere and controls and spaces at the end, reads
// a backslash as a slash and %2e as a dot in a "..", and a server or proxy
// that decodes %2f or %5c before cleaning the path reads those as slashes
// too. So a dot-dot segment between any of those separators climbs; one
// without a dot-dot climbs nowhere, which keeps a name with a backslash in it
// (quoted as %5C) under its prefix.
const SEPARATOR = /[/\\]|%2f|%5c/i;
const DOT_DOT_SEGMENT = /^(\.|%2e){2}$/i;

// The query and fragment are not path, so a ".." there climbs nowhere.
export function isPathUnder(href: string, prefix: string): boolean {
  if (!href.startsWith(prefix)) return false;
  const parsed = href.replace(/[\t\n\r]/g, "").replace(/[\u0000-\u0020]+$/, "");
  const path = parsed.split(/[?#]/, 1)[0];
  return !path.split(SEPARATOR).some((segment) => DOT_DOT_SEGMENT.test(segment));
}

export function isUploadedAsset(src: string): boolean {
  return isPathUnder(src, "/assets/");
}

// A protocol-relative src fetches from its host over the page's scheme, so it
// is parsed as https: to name that host.
function hostOf(src: string): string {
  try {
    return new URL(src.startsWith("//") ? `https:${src}` : src).host;
  } catch {
    return "";
  }
}

export function externalImageLabel(src: string, alt: string): string {
  const host = hostOf(src);
  const source = host ? `image from ${host}` : "external image";
  return alt ? `${source}: ${alt}` : source;
}
