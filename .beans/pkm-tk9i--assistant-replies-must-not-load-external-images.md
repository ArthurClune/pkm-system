---
# pkm-tk9i
title: Assistant replies must not load external images
status: completed
type: task
priority: high
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T15:46:21Z
parent: pkm-mfd0
---

Review finding (High): assistant output provides an unapproved outbound data channel. AssetImage loads external URLs from assistant markdown with no click, so an injected model can exfiltrate note text in an image URL.

- [x] Red test first, from the review probe: the first-pass probe was not kept; rebuild it from the review doc's reproduction (fresh Chromium, real tokenizer and AssetImage, intercepted requests). Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [x] Assistant replies render external images as a link or placeholder (no automatic request); app-hosted /assets/ images still render
- [x] Decide whether the same applies to note rendering generally or only assistant output (Arthur 2026-10-23: external images load on click everywhere; Bluesky embeds load on click only in assistant replies. Spec: docs/superpowers/specs/2026-10-23-external-media-click-to-load-design.md)
- [x] Browser test with intercepted requests proving no request leaves for an external image

## Summary of Changes

External images now load on click everywhere: `AssetImage` renders a placeholder button naming the host for any src outside `/assets/`, and mounts the `<img>` only for the clicked src. `BlueskyEmbed` does the same under the new `UntrustedContentContext`, which `AssistantPanel` provides, so no handle lookup or iframe request happens before a click. Architecture docs, the styling note and a troubleshooting row were updated.

After the reviews: one `ClickToLoad` component is the gate for every medium, and focus moves to the revealed item. An adversarial review found stock mermaid (the fallback when beautiful-mermaid rejects a diagram) loading `<img>` in labels, `themeCSS url()` and image shapes. Stock mermaid is now hardened everywhere: secured theme keys, a DOMPurify forbid list, and refusal of image shapes and constructs it cannot sanitise (`mermaidSafety.ts`). In replies the stock fallback waits behind "Render diagram". beautiful-mermaid's Google Fonts `@import` is stripped (the perf warm scenario makes one fewer request). `isUploadedAsset` refuses `..`, encoded slashes and backslashes. All 10 prod diagrams still render through beautiful-mermaid. Follow-ups: pkm-0d4e, pkm-u48q, pkm-gvbd; CSP stays with pkm-e95y.
