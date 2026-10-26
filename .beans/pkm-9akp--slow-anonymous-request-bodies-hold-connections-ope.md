---
# pkm-9akp
title: Slow anonymous request bodies hold connections open
status: completed
type: bug
priority: low
created_at: 2026-10-25T09:27:58Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

From the pkm-zav2 work (2026-10-25). uvicorn has no body-read timeout, so an anonymous POST /api/login that drips its body a byte at a time, staying under PUBLIC_BODY_MAX_BYTES, holds a connection open indefinitely (at most 8 KiB kept). Many such connections exhaust sockets/workers. Predates the auth gate. Widened (zav2 final review, 2026-10-25): after the gate's 401 on ANY private route, uvicorn still reads and discards the rest of the body; a client sending one byte a second held a connection 15 s (3x uvicorn's 5 s keep-alive). A fix must cover refused private bodies too (e.g. Connection: close on gate refusals, or a server-level body-read deadline), not only slow public bodies. Options: a body-read deadline in the gate for public bodies, uvicorn timeout settings, or limit-concurrency.

- [x] Measure with a slowloris probe on a scratch server
- [x] Deadline for public body reads (or server setting); test
- [x] troubleshooting.md row

## Summary of Changes

- Behaviour: a late client is cut. DeadlineH11Protocol (http_protocol.py, installed only by run.uvicorn_config; the E2E and proptest launchers now serve through it too) closes a connection whose request head has not arrived 10 s after open or after its last response, which also bounds the drain of a refused body; public bodies have a 10 s read deadline in the gate (408 with Connection: close); a stalled-write deadline (WRITE_STALL_TIMEOUT_S = 300 s) cuts a client that stops reading its response; the head deadline is kept off upgraded WebSockets. Measured first: 30 s probes on a scratch run.main (dripped refused POST /api/ops, dripped /api/login under the cap, idle connection, dripped headers) were all still open at 30 s; after the change they are closed (probes in the task report).
- Commits: d09d014e, ce5ec42b, 13b0143d, 768f7c99, 1c2d0488, 96c84874, 2d562e3a, 6940843d. Troubleshooting rows for slow heads/bodies, the unread-response hold, and the WebSocket cut.
- Rulings: deviation from the brief: 401 and 413 do NOT carry Connection: close (closing with a refused body still arriving resets the socket and the client loses the answer; evidence in the report); the deadline protocol bounds the drain instead. Orchestrator: stalled-write deadline added rather than only documented (the docs claimed slow clients are bounded), then raised from 60 s to 300 s because flow control resumes in ~260 KiB steps (floor about 0.9 KiB/s), stated honestly in the constant, Auth table and troubleshooting row. An upload past limit+64 KiB gets the gate's 413 then is cut at 10 s: accepted and documented. Authenticated slow bodies get no deadline (slow large uploads); a stolen cookie can still hold connections.
- Follow-ups: none filed.
