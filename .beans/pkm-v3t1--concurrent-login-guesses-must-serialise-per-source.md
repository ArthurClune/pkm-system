---
# pkm-v3t1
title: Concurrent login guesses must serialise per source
status: todo
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-u8uh. The throttle is checked before the password and a failure recorded after, so 200 concurrent guesses ran 40 scrypt checks. Opus designs: reserve the attempt (or hold a per-source lock) before the scrypt check. Mind the anyio threadpool, the scrypt semaphore and its 2 s timeout. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-cross/probe_throttle.py.

- [ ] Red test: the probe's 200-concurrent burst expects one check per backoff window
- [ ] Fix
- [ ] troubleshooting.md row; SECURITY.md via pkm-e95y
