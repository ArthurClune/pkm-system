---
# pkm-9akp
title: Slow anonymous request bodies hold connections open
status: todo
type: bug
priority: low
created_at: 2026-10-25T09:27:58Z
updated_at: 2026-10-25T09:39:58Z
parent: pkm-mfd0
---

From the pkm-zav2 work (2026-10-25). uvicorn has no body-read timeout, so an anonymous POST /api/login that drips its body a byte at a time, staying under PUBLIC_BODY_MAX_BYTES, holds a connection open indefinitely (at most 8 KiB kept). Many such connections exhaust sockets/workers. Predates the auth gate. Widened (zav2 final review, 2026-10-25): after the gate's 401 on ANY private route, uvicorn still reads and discards the rest of the body; a client sending one byte a second held a connection 15 s (3x uvicorn's 5 s keep-alive). A fix must cover refused private bodies too (e.g. Connection: close on gate refusals, or a server-level body-read deadline), not only slow public bodies. Options: a body-read deadline in the gate for public bodies, uvicorn timeout settings, or limit-concurrency.

- [ ] Measure with a slowloris probe on a scratch server
- [ ] Deadline for public body reads (or server setting); test
- [ ] troubleshooting.md row
