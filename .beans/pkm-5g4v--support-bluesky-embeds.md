---
# pkm-5g4v
title: Support Bluesky embeds
status: completed
type: feature
priority: low
created_at: 2026-07-10T12:50:51Z
updated_at: 2026-07-10T13:09:23Z
---

Support embedding Bluesky posts (rendering a pasted Bluesky post URL as an embedded post, similar to other social embeds).



## Summary of Changes

Followed the existing PdfEmbed pattern (the only special-href embed in the codebase; no Twitter/YouTube embeds existed to mirror) in `web/src/components/InlineSegments.tsx`: a markdown link `[text](href)` whose href matches a Bluesky post URL renders as an embed instead of a plain anchor.

- Added `web/src/components/BlueskyEmbed.tsx` (Functional Core): `parseBlueskyPostUrl`/`isBlueskyPostUrl` validate/parse `https://bsky.app/profile/<actor>/post/<rkey>` (actor may be a handle or DID; scheme, host, and path shape are all checked, rejecting lookalike hosts and non-post paths), `blueskyEmbedSrc` builds the direct `https://embed.bsky.app/embed/<actor>/app.bsky.feed.post/<rkey>?ref_url=...` iframe URL (same target as Bluesky's oEmbed endpoint, without the extra network round-trip), and `BlueskyEmbed` renders a sandboxed `<iframe>`.
- Wired into `InlineSegments.tsx`'s `link` case, alongside the existing `isPdfAssetHref` check.
- Added `.bluesky-embed` CSS in `web/src/styles.css`, mirroring `.pdf-viewer`.
- Tests: `web/src/components/BlueskyEmbed.test.tsx` (parsing/detection/src-building/render, including rejecting non-post and lookalike-host URLs) and two new cases in `web/src/components/InlineSegments.test.tsx` (post link embeds, non-post bsky link stays a plain anchor).

Verified: `pnpm test -- --run` (285 tests passed) and `pnpm typecheck` (clean) from `web/`. No server code touched.
