---
# pkm-fjkx
title: Bluesky embeds open in the PWA's in-app browser, not Safari
status: completed
type: bug
priority: normal
created_at: 2026-10-17T14:34:53Z
updated_at: 2026-10-17T14:37:23Z
---

In the iOS standalone PWA, tapping a Bluesky embed opens the in-app WKWebView overlay. The embed is a cross-origin iframe, so its clicks never reach ExternalLinkInterceptor's document listener.

- [x] In iOS standalone, cover the iframe with an anchor to the post so the interceptor sends it to Safari
- [x] Unit tests
- [x] Docs

## Summary of Changes

In the iOS standalone app, `BlueskyEmbed` lays a `.bluesky-embed-tap` anchor to the post over the iframe, so `ExternalLinkInterceptor` sends the tap to Safari. Trade-off: every tap opens the post itself, not the inner author/link target. `stubIosStandaloneNavigator` moved to `test-helpers.ts`. Docs: frontend.md external-links section, troubleshooting row.
