---
# pkm-lamg
title: 'Login throttle key: set proxy_headers / forwarded_allow_ips explicitly'
status: todo
type: task
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-u8uh. The throttle key is request.client.host via uvicorn's default X-Forwarded-For handling on loopback, which SECURITY.md misdescribes. Ops first: observe what Tailscale Serve sends in X-Forwarded-For (scratch server behind a test Serve), then set the values explicitly in run.py. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-cross/probe_throttle.py.

- [ ] Observe Tailscale Serve's X-Forwarded-For on a scratch server
- [ ] Set proxy_headers / forwarded_allow_ips explicitly in run.py, with a test
- [ ] deploy/README or backend.md note
