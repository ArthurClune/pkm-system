---
# pkm-zav2
title: Reject unauthenticated requests before reading the body
status: todo
type: task
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
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
