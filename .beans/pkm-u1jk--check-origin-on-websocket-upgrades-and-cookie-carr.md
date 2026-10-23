---
# pkm-u1jk
title: Check Origin on WebSocket upgrades and cookie-carrying simple POSTs
status: todo
type: task
priority: high
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T10:56:19Z
parent: pkm-mfd0
---

Review finding (Medium): ts.net is a public suffix, so every tailnet host (Funnel ones included) is same-site with PKM. /api/ws accepts any Origin and streams the full text of every op; a sibling page sends the Lax cookie on the handshake.

- [ ] Red test first, from the review probe: sec-cross/probe_ws_origin.py and sec-cross/probe_csrf.py. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] /api/ws refuses a handshake whose Origin is not the app's own origin(s)
- [ ] Same check on the state-changing routes that accept simple requests: POST /api/journal/cleanup, /api/assets/scan, /api/assets (multipart), the assistant close beacon, /api/assets/export.zip
- [ ] Decide how the allowed origin is configured (Serve hostname, direct-IP listener)
- [ ] Tests: foreign Origin refused, own Origin accepted, missing Origin (non-browser clients, CLI) still works
