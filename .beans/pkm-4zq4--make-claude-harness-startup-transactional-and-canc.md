---
# pkm-4zq4
title: Make Claude harness startup transactional and cancellation-safe
status: todo
type: bug
priority: high
created_at: 2026-07-31T15:54:44Z
updated_at: 2026-07-31T15:54:44Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 4.

**References:** server/src/pkm/assistant/claude_engine.py:245-280

Startup writes a 0600 config containing a long-lived session token, creates the SDK client, and connects it without cleanup around failure or cancellation. Factory/connect failures can leave the credential file and a partially started subprocess/client behind.

**Direction:** Wrap all work after config creation in cancellation-safe cleanup that disconnects any created client and always unlinks the config before re-raising.

- [ ] Test factory failure, partial connect failure, and cancellation during connect
- [ ] Assert credential unlink and client disconnect on every failed startup path
