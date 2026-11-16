---
# pkm-ank8
title: Non-ASCII session cookie signature gives an anonymous 500
status: completed
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-11-16T10:20:47Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-u8uh. A non-ASCII pkm_session signature makes hmac.compare_digest raise TypeError: anonymous 500 on HTTP and on the WS handshake.

- [x] Red hostile-request tests: HTTP 401 and WS close 4401 for a non-ASCII and a non-hex signature
- [x] verify_session rejects a signature that is not ASCII hex of the right length before compare_digest
- [x] troubleshooting.md row

## Summary of Changes

`verify_session` checks the signature is ASCII and of the expected length before `hmac.compare_digest`, which stays for well-formed input. Hostile-request tests cover HTTP 401 and WS close 4401 for non-ASCII, non-hex and wrong-length signatures. Troubleshooting row added.
