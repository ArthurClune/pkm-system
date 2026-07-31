---
# pkm-rovq
title: Serialize assistant conversation admission
status: todo
type: bug
priority: high
created_at: 2026-07-31T15:54:41Z
updated_at: 2026-07-31T15:54:41Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 3.

**References:** server/src/pkm/assistant/service.py:54-69

The conversation-cap check occurs before awaiting engine.create_conversation(). Concurrent requests can both observe free capacity and start harnesses, bypassing the configured cap or over-evicting idle conversations.

**Direction:** Serialize admission with a lock or atomically reserve creation slots, releasing reservations on every failure/cancellation path.

- [ ] Add barrier-controlled concurrent creation tests
- [ ] Enforce the cap across active and in-progress creations
