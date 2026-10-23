---
# pkm-u8uh
title: 'Auth hardening: login burst, proxy headers, pre-auth bodies, cookie parsing'
status: scrapped
type: task
priority: normal
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T18:15:45Z
parent: pkm-mfd0
---

Review findings (Low): (1) the throttle is checked before the password and a failure recorded after, so 200 concurrent guesses ran 40 scrypt checks; (2) the throttle key is request.client.host via uvicorn's default X-Forwarded-For handling on loopback, which SECURITY.md misdescribes; (3) FastAPI reads the whole body before require_auth, so anonymous 64 MiB bodies are held or spooled and max_upload_bytes applies only after auth; (4) a non-ASCII pkm_session signature makes hmac.compare_digest raise, giving an anonymous 500 (HTTP and WS).

- [ ] Red test first, from the review probe: sec-cross/probe_throttle.py, probe_preauth.py and probe_cookie500.py. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] Reserve the attempt before the password check so concurrent guesses from one source serialise
- [ ] Set proxy_headers / forwarded_allow_ips explicitly in run.py; verify what Tailscale Serve sends
- [ ] Reject unauthenticated requests before reading the body (auth middleware or a body-size cap for anonymous requests)
- [ ] verify_session rejects non-ASCII/non-hex signatures before comparing; hostile-request test

Note from the guard tests: if auth moves into a middleware, the forgotten-auth teeth test in server/tests/test_auth.py fails, because a route added with @app.get becomes protected. That is the fix working, not a regression: rewrite the test to prove the middleware's allow-list is exactly PUBLIC_ROUTES, and update the PUBLIC_ROUTES comment that names require_auth.

## Reasons for Scrapping

Split into one bean per item (2026-10-23): pkm-ank8 cookie 500, pkm-v3t1 login burst, pkm-lamg proxy headers, pkm-zav2 auth before body read.
