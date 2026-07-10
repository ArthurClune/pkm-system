---
# pkm-es9o
title: 'Bluesky embed iframe ''Invalid DID'': embed path needs DID, not handle'
status: completed
type: bug
priority: normal
created_at: 2026-07-10T16:34:06Z
updated_at: 2026-07-10T16:48:24Z
---

pkm-5g4v/pkm-vuhl built the embed.bsky.app iframe src straight from the post URL's actor segment, but embed.bsky.app/embed/<actor>/... only accepts DIDs — a handle like cpaxton.bsky.social renders Bluesky's 'Invalid DID: DID syntax didn't validate via regex' page inside the iframe (seen on Robots page after deploy). Verified: same URL with the resolved DID works, and com.atproto.identity.resolveHandle on public.api.bsky.app is CORS-open. Fix: resolve handle->DID client-side (cached), build src from the DID, fall back to a plain link if resolution fails.

## Summary of Changes

Two root causes, both verified against the live services before fixing:

1. **Embed path requires a DID.** `embed.bsky.app/embed/<actor>/...` rejects handles ('Invalid DID' page). BlueskyEmbed is now an Imperative Shell component that resolves handle->DID via public.api.bsky.app's CORS-open resolveHandle (module-level cache, shared across mounts, failures evicted for retry), renders the iframe from the DID, and falls back to a plain post link while resolving / on failure. Pure URL parsing + src building moved to components/bluesky.ts (Functional Core).
2. **Sandbox opaque origin blanked the embed.** With `sandbox` but no `allow-same-origin`, the embed page rendered empty (probed side-by-side). Added `allow-same-origin` — Bluesky's official embed.js uses no sandbox at all, so this is still stricter than upstream.

Also adopted the official height protocol: the iframe src carries an `id` param and the component listens for embed.bsky.app postMessage height reports, so embeds size to their content instead of clipping at 300px.

Verified: 294 unit tests + typecheck, 4/4 Playwright e2e (hermetic resolveHandle route), and a live no-mock probe against the built app — full post (text, video, counts) renders and the iframe self-sizes.
