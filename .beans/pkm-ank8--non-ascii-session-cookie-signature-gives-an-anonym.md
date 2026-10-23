---
# pkm-ank8
title: Non-ASCII session cookie signature gives an anonymous 500
status: todo
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-u8uh. A non-ASCII pkm_session signature makes hmac.compare_digest raise TypeError: anonymous 500 on HTTP and on the WS handshake. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-cross/probe_cookie500.py.

- [ ] Red hostile-request tests: HTTP 401 and WS close 4401 for a non-ASCII and a non-hex signature
- [ ] verify_session rejects a signature that is not ASCII hex of the right length before compare_digest
- [ ] troubleshooting.md row
