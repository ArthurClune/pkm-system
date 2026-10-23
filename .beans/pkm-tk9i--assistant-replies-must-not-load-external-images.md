---
# pkm-tk9i
title: Assistant replies must not load external images
status: todo
type: task
priority: high
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T10:56:19Z
parent: pkm-mfd0
---

Review finding (High): assistant output provides an unapproved outbound data channel. AssetImage loads external URLs from assistant markdown with no click, so an injected model can exfiltrate note text in an image URL.

- [ ] Assistant replies render external images as a link or placeholder (no automatic request); app-hosted /assets/ images still render
- [ ] Decide whether the same applies to note rendering generally or only assistant output
- [ ] Browser test with intercepted requests proving no request leaves for an external image
