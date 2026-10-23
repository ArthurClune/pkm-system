---
# pkm-gvbd
title: 'Send X-DNS-Prefetch-Control: off'
status: in-progress
type: task
priority: low
created_at: 2026-10-23T15:00:12Z
updated_at: 2026-10-23T15:00:20Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Adversarial review of pkm-tk9i (M4, unverified). Browsers may DNS-prefetch the hosts of `<a href>`s on plain-HTTP pages, so a reply containing `https://<secret>.attacker.example/` could leak through DNS. Production is HTTPS via Tailscale Serve, but the server also listens on plain HTTP (127.0.0.1:8974, the Tailscale IP). Playwright net-log could neither confirm nor refute it. Fix: one response header from the server, `X-DNS-Prefetch-Control: off`; fold into pkm-e95y's CSP work if that comes first.

- [x] Header on every response, with a test
- [ ] Note in SECURITY.md via pkm-e95y

## Summary of Changes

`SecurityHeadersMiddleware` (`server/src/pkm/server/security_headers.py`) sends `X-DNS-Prefetch-Control: off` on every HTTP response. `server/tests/test_security_headers.py` covers an anonymous 401, an authed JSON route, the login page, the SPA index, a static asset and two 404s. The SECURITY.md note is pending, via pkm-e95y, so the bean stays in progress.
