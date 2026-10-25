---
# pkm-lamg
title: 'Login throttle key: set proxy_headers / forwarded_allow_ips explicitly'
status: in-progress
type: task
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-25T03:15:18Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-u8uh. The throttle key is request.client.host via uvicorn's default X-Forwarded-For handling on loopback, which SECURITY.md misdescribes. Ops first: observe what Tailscale Serve sends in X-Forwarded-For (scratch server behind a test Serve), then set the values explicitly in run.py. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-cross/probe_throttle.py.

- [x] Observe Tailscale Serve's X-Forwarded-For on a scratch server
- [x] Set proxy_headers / forwarded_allow_ips explicitly in run.py, with a test
- [x] deploy/README or backend.md note

## Summary of Changes

- Observed (2026-10-25, scratch server behind a test Serve on 8443): Serve sets X-Forwarded-For to the device's tailnet address and drops any the client sent; it passes X-Real-IP through unchanged. Table in docs/superpowers/plans/2026-10-25-login-throttle.md. Single device only; a second device was not reachable.
- `run.uvicorn_config` passes `proxy_headers=True` and `forwarded_allow_ips=run.FORWARDED_ALLOW_IPS` (`"127.0.0.1"`), so a `FORWARDED_ALLOW_IPS` environment variable cannot widen trust. The key is the Serve-set address on loopback and the TCP peer on the Tailscale-IP listener. Pinned by `server/tests/test_run_proxy_trust.py`.
- Docs: backend.md § Login throttle (key per listener, the two unenforced conditions: Serve's upstream stays `http://127.0.0.1:<port>`, launchd starts via `pkm.server.run`); deploy/README.md first-install note; troubleshooting row.
- SECURITY.md's "shares the proxy's bucket" is left to pkm-e95y.
