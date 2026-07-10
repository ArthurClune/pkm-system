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

/** Builds the direct embed.bsky.app iframe src for a post URL, or null if
 * href isn't a Bluesky post URL. Mirrors the shape returned by Bluesky's
 * oEmbed endpoint (https://embed.bsky.app/oembed?url=...) without the
 * extra network round-trip. */
export function blueskyEmbedSrc(href: string): string | null {
  const parsed = parseBlueskyPostUrl(href);
  if (!parsed) return null;
  const { actor, rkey } = parsed;
  return `https://embed.bsky.app/embed/${actor}/app.bsky.feed.post/${rkey}` +
    `?ref_url=${encodeURIComponent(href)}`;
}

export function BlueskyEmbed({ href }: { href: string }) {
  const src = blueskyEmbedSrc(href);
  if (!src) return null;
  return (
    <iframe
      src={src}
      className="bluesky-embed"
      title="Bluesky post"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
    />
  );
}
