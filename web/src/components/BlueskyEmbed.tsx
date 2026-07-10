// pattern: Imperative Shell
import { useEffect, useId, useState } from "react";
import { blueskyEmbedSrc, parseBlueskyPostUrl } from "./bluesky";

const EMBED_ORIGIN = "https://embed.bsky.app";
const RESOLVE_URL =
  "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=";

// module-level so every embed of the same author across the app shares one
// resolution; failures are evicted so a transient network error can retry
const didCache = new Map<string, Promise<string>>();

function resolveHandle(handle: string): Promise<string> {
  let pending = didCache.get(handle);
  if (!pending) {
    pending = fetch(RESOLVE_URL + encodeURIComponent(handle)).then(async (r) => {
      if (!r.ok) throw new Error(`resolveHandle: ${r.status}`);
      const body = (await r.json()) as { did?: unknown };
      if (typeof body.did !== "string" || !body.did.startsWith("did:")) {
        throw new Error("resolveHandle: no did in response");
      }
      return body.did;
    });
    pending.catch(() => didCache.delete(handle));
    didCache.set(handle, pending);
  }
  return pending;
}

export function BlueskyEmbed({ href }: { href: string }) {
  const embedId = useId();
  const actor = parseBlueskyPostUrl(href)?.actor ?? null;
  const [did, setDid] = useState<string | null>(
    actor?.startsWith("did:") ? actor : null,
  );
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!actor || actor.startsWith("did:")) return;
    let alive = true;
    setDid(null);
    resolveHandle(actor).then(
      (resolved) => { if (alive) setDid(resolved); },
      () => {},
    );
    return () => { alive = false; };
  }, [href, actor]);

  // the embed page reports its rendered height, keyed by our id param —
  // the same protocol Bluesky's official embed.js uses
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== EMBED_ORIGIN) return;
      const data = event.data as { id?: unknown; height?: unknown };
      if (data.id === embedId && typeof data.height === "number") {
        setHeight(data.height);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [embedId]);

  if (!actor) return null;
  if (!did) {
    // resolving, or resolution failed: the post link is still useful
    return <a href={href} target="_blank" rel="noreferrer">{href}</a>;
  }
  return (
    <iframe
      src={blueskyEmbedSrc(href, did, embedId)!}
      className="bluesky-embed"
      title="Bluesky post"
      style={height === null ? undefined : { height }}
      // allow-same-origin is required: with an opaque origin the embed
      // page renders blank (pkm-es9o); this matches Bluesky's official
      // embed.js, which uses no sandbox at all
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    />
  );
}
