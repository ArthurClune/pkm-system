---
# pkm-u1jk
title: Check Origin on WebSocket upgrades and cookie-carrying simple POSTs
status: completed
type: task
priority: high
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-24T20:01:13Z
parent: pkm-mfd0
---

Review finding (Medium): ts.net is a public suffix, so every tailnet host (Funnel ones included) is same-site with PKM. /api/ws accepts any Origin and streams the full text of every op; a sibling page sends the Lax cookie on the handshake.

- [x] Red test first, from the review probe: sec-cross/probe_ws_origin.py and sec-cross/probe_csrf.py. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] /api/ws refuses a handshake whose Origin is not the app's own origin(s)
- [ ] Same check on the state-changing routes that accept simple requests: POST /api/journal/cleanup, /api/assets/scan, /api/assets (multipart), the assistant close beacon, /api/assets/export.zip
- [x] Decide how the allowed origin is configured (Serve hostname, direct-IP listener)
- [x] Tests: foreign Origin refused, own Origin accepted, missing Origin (non-browser clients, CLI) still works

Note from the guard tests: test_hostile_requests.py's content-type walk counts 415, or a 422 whose only loc is ["body"], as a refusal. A fix that refuses non-JSON bodies some other way (403 from an Origin check) must widen that predicate, not delete the walk.

## Decision (Arthur, 2026-10-24)

See docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md, row pkm-u1jk.

## Summary of Changes

- New pure-ASGI OriginGuardMiddleware (origin_core.py core, origin_guard.py shell) checks the Origin of every /api/ws handshake (close 4403 before accept) and every non-GET/HEAD/OPTIONS request (403 {"detail":"origin not allowed"}) before routing, auth or body parsing. No Origin passes; exactly one Origin in the allowed set passes; null, empty and duplicate Origins are refused.
- Allowed set: new config key serve_origins (list of full origins, normalised at load, malformed entry refuses startup), each bind_hosts listener on the served port, loopback on the served port. run.py hands create_app the hosts it actually binds; tests/e2e_serve.py passes its port.
- Vite dev proxy rewrites Origin to the backend's only when it equals http://<Host> (same-origin with the dev server), so pnpm dev keeps working without laundering other localhost origins.
- test_hostile_requests content-type walk widened (403 counts as refusal only when a foreign Origin is sent) and parametrised over no/foreign Origin; walk over every unsafe route with a foreign Origin.
- Docs: backend.md § Auth (rules and reasons incl. never Referrer-Policy: no-referrer), frontend.md dev proxy, troubleshooting row, deploy README/install.sh serve_origins.
- Rulings: one middleware over all unsafe methods rather than a per-route list; safe methods unchecked; Origin: null refused.
