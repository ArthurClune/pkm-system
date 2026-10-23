---
# pkm-tk9i
title: Assistant replies must not load external images
status: in-progress
type: task
priority: high
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T14:11:01Z
parent: pkm-mfd0
---

Review finding (High): assistant output provides an unapproved outbound data channel. AssetImage loads external URLs from assistant markdown with no click, so an injected model can exfiltrate note text in an image URL.

- [ ] Red test first, from the review probe: the first-pass probe was not kept; rebuild it from the review doc's reproduction (fresh Chromium, real tokenizer and AssetImage, intercepted requests). Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] Assistant replies render external images as a link or placeholder (no automatic request); app-hosted /assets/ images still render
- [x] Decide whether the same applies to note rendering generally or only assistant output (Arthur 2026-10-23: external images load on click everywhere; Bluesky embeds load on click only in assistant replies. Spec: docs/superpowers/specs/2026-10-23-external-media-click-to-load-design.md)
- [ ] Browser test with intercepted requests proving no request leaves for an external image
