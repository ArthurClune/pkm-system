// pattern: Functional Core
// Which media the app may fetch on render, and how a placeholder names the
// rest. Only uploaded assets (same-origin /assets/ paths) load unprompted;
// any other src, data: and blob: included, is external.

// A src the URL parser would turn into another same-origin path is not an
// asset: /assets/../api/export.zip would run an export on render. The parser
// drops tabs and newlines anywhere, reads a backslash as a slash, and reads
// %2e as a dot in a "..": so each of those, and an encoded slash, counts.
const DOT_DOT_SEGMENT = /^(\.|%2e){2}$/i;

export function isUploadedAsset(src: string): boolean {
  if (!src.startsWith("/assets/")) return false;
  const path = src.replace(/[\t\n\r]/g, "");
  if (path.includes("\\") || /%2f|%5c/i.test(path)) return false;
  return !path.split("/").some((segment) => DOT_DOT_SEGMENT.test(segment));
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
