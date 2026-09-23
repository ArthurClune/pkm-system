---
# pkm-0525
title: Labelled Bluesky links stay links; only bare post URLs embed
status: completed
type: feature
priority: normal
created_at: 2026-09-23T14:56:57Z
updated_at: 2026-09-23T15:01:11Z
---

A bare Bluesky post URL renders as an embed, but a markdown link with its own label (e.g. [source](https://bsky.app/profile/x/post/y)) should render as a plain external link with no embed.

Design (approved in chat): in InlineSegments.tsx's link case, embed only when seg.text === seg.href (bare autolinked URL, or a markdown link whose label is the URL itself). PDF embeds unchanged.

- [x] Failing unit test: labelled bsky post link renders plain anchor, no iframe
- [x] Unit test: bare bsky post URL still embeds
- [x] Renderer change in InlineSegments.tsx
- [x] Update docs/architecture/frontend-rendering.md link row
- [x] pnpm verify green

## Summary of Changes

`InlineSegments.tsx`'s `link` case now embeds a Bluesky post only when `seg.text === seg.href`: a bare autolinked URL, or a markdown link whose label is the URL itself. A labelled link like `[source](https://bsky.app/…/post/…)` falls through to the ordinary safe `<a target="_blank">`. Tokenizer, segment types and the PDF embed rule are unchanged.

Tests (InlineSegments.test.tsx): the existing embed case now uses a bare URL; new cases cover `[url](url)` embedding and `[source](url)` rendering a plain link with no iframe (red before the fix). The segment-dispatch row in `docs/architecture/frontend-rendering.md` is updated.

Verified: `pnpm verify` (2584 unit tests, typecheck, build, 59/59 e2e including the embeds.spec.ts bare-URL path) passed twice with no flakes.
