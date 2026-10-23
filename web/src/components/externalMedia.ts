// pattern: Functional Core
// Which media the app may fetch on render, and how a placeholder names the
// rest. Only uploaded assets (same-origin /assets/ paths) load unprompted;
// any other src, data: and blob: included, is external.

export function isUploadedAsset(src: string): boolean {
  return src.startsWith("/assets/");
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
