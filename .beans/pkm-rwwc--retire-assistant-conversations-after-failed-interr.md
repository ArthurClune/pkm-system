---
# pkm-rwwc
title: Retire assistant conversations after failed interrupts
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 14).

## Context

**References:** `server/src/pkm/assistant/claude_engine.py:147-201`; `server/src/pkm/assistant/service.py:86-93`

If interrupt times out or raises, local cleanup continues and the service marks the conversation not busy even though the subprocess may still be running. The uncertain harness is then reusable for later turns, risking stale events, concurrent queries, or continued token use.

**Direction:** Treat unacknowledged interrupt as terminal: disconnect/kill the harness and remove or invalidate the conversation.

## Tasks

- [ ] Add a second-send test after interrupt timeout/failure
- [ ] Prevent reuse of uncertain harnesses
