---
# pkm-zav2
title: Reject unauthenticated requests before reading the body
status: completed
type: task
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-25T09:40:33Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-u8uh. FastAPI reads the whole body before require_auth, so anonymous 64 MiB bodies are held or spooled and max_upload_bytes applies only after auth. Opus designs: auth as ASGI middleware ahead of body parsing, or an anonymous-request body cap. Must keep the public routes, the WS 4401 path and the route-walk tests green. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-cross/probe_preauth.py.

Note from the guard tests: if auth moves into a middleware, the forgotten-auth teeth test in server/tests/test_auth.py fails, because a route added with @app.get becomes protected. That is the fix working: rewrite the test to prove the middleware's allow-list is exactly PUBLIC_ROUTES, and update the PUBLIC_ROUTES comment that names require_auth.

- [ ] Red test from the probe
- [ ] Design + fix
- [ ] perf/check.sh backend; hostile-request suite
- [ ] backend.md auth section; troubleshooting.md row

## Summary of Changes

- AuthGateMiddleware (pure ASGI, inside the Origin guard, outside the router) refuses an unauthenticated request before the app reads its body: HTTP 401 {"detail": "not authenticated"}, WS handshake refused as before. Public set is a path predicate (auth_gate_core.is_public) on the router's own get_route_path: websockets never public; POST /api/login public; GET/HEAD outside /api and /assets public. test_the_gate_admits_exactly_the_public_routes proves the admitted set equals PUBLIC_ROUTES (replacing the forgotten-auth teeth test). Depends(require_auth) and the WS inline check stay as a second layer; the session check lives once in auth.session_is_valid.
- Public bodies (POST /api/login) are capped at PUBLIC_BODY_MAX_BYTES (8 KiB): 413 for a declared over-cap Content-Length, buffered pre-read replayed otherwise; an over-cap login never reaches the throttle.
- Measured: anonymous /api/ops and uploads went from 64 MiB read before the 401 to 0 bytes; login from 64 MiB to the cap. Real-socket tests pin it.
- Perf backend: no counts moved. Docs: backend.md § Auth, troubleshooting row. uvicorn still drains a refused body (tracked in pkm-9akp).
