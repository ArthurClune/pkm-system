---
# pkm-uue4
title: WS backoff resets on an accept-then-close socket; frozen sockets not detected
status: todo
type: bug
priority: low
created_at: 2026-09-02T03:41:21Z
updated_at: 2026-09-02T03:41:21Z
parent: pkm-fgjg
---

Found by the pkm-fgjg final whole-branch review (2026-09-02); deferred from pkm-d6i6's task review.

## Symptom
`web/src/sync/socket.ts` (`sock.onopen`, ~:122) unconditionally resets the backoff counter (`priorFailures = 0`), including for a socket the server accepts and then closes immediately (auth expiry, load shedding, a middlebox that completes the handshake then drops). Against such a server the backoff never grows past the 2 s base — a hot reconnect loop exactly when the server is unhealthy, which is what pkm-d6i6's backoff was meant to prevent.

Related, same area: a socket frozen by the OS while the tab was backgrounded (iPadOS/Safari `freeze`) is not detected or healed by `reconnectNow()`; `socket.ts`'s header and `frontend.md` were reworded in the epic's fix wave to stop claiming it is. A liveness check (ping/pong or "no frame in N s after resume → close and reconnect") would close both gaps.

## Fix sketch
Reset `priorFailures` only after the socket has stayed open past a threshold: first frame received, or a short `setTimeout` cleared by `onclose`. Unit test with fake timers in `reconnectBackoff.test.ts` / `socket.test.ts`: accept-then-close ×5 → attempt gaps grow 2, 4, 8, 16, 30 s.

## Checklist
- [ ] Failing test: accept-then-immediate-close does not reset backoff
- [ ] Reset backoff only after the socket proves live
- [ ] Decide on a resume-time liveness check for frozen sockets (or file separately)
- [ ] `sync-and-offline.md` backoff note
