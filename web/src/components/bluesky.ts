// pattern: Functional Core

// Handles ("alice.bsky.social") and DIDs ("did:plc:...") are both valid
// actor identifiers in a Bluesky post URL; only the path shape is checked
// here, so anything without a slash is accepted for that segment.
const POST_URL_RE = /^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/([a-zA-Z0-9]+)$/;

export function parseBlueskyPostUrl(href: string): { actor: string; rkey: string } | null {
  const m = POST_URL_RE.exec(href);
  if (!m) return null;
  return { actor: m[1], rkey: m[2] };
}

export function isBlueskyPostUrl(href: string): boolean {
  return parseBlueskyPostUrl(href) !== null;
}

/** Builds the embed.bsky.app iframe src for a post URL, or null if href
 * isn't a Bluesky post URL. The embed path only accepts DIDs — a handle
 * renders Bluesky's "Invalid DID" page (pkm-es9o) — so the caller must
 * pass the actor's resolved DID. `id` keys the embed page's postMessage
 * height reports back to this iframe; the original href rides along as
 * ref_url. */
export function blueskyEmbedSrc(href: string, did: string, id: string): string | null {
  const parsed = parseBlueskyPostUrl(href);
  if (!parsed) return null;
  return `https://embed.bsky.app/embed/${did}/app.bsky.feed.post/${parsed.rkey}` +
    `?id=${encodeURIComponent(id)}&ref_url=${encodeURIComponent(href)}`;
}
