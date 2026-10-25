---
# pkm-qotb
title: 'Staleness stamp: a stopped turn''s in-flight write is forgotten by the next turn'
status: in-progress
type: bug
priority: low
created_at: 2026-10-25T02:20:05Z
updated_at: 2026-10-25T09:38:34Z
parent: pkm-mfd0
---

From the pkm-g2w9 final re-review (2026-10-25). The assistant's send() clears the running-writes set at the start of each turn. If a turn was stopped or timed out while an allowed write was still in flight, the next turn's first approval card can read its target before that write lands and carry no writes_in_flight stamp, so no staleness marker shows.

- [x] Red test: stop a turn with an allowed write running; next turn's first card is stamped
- [x] Clear each write from the set when it finishes, not at turn start
- [x] troubleshooting.md row

## Summary of Changes

c71b8f3d: a turn's allowed writes are forgotten when the turn finishes, not when the next one starts.
- Server: `ClaudeConversation.send` clears `_running_writes` on `TurnDone`.
- Web: `useAssistant` zeroes `allowedInTurn` on `turn_done` and on adopting a new conversation.
- So after Stop, or a turn that errors, a write still running stamps the next turn's cards, and the stale line counts its Allow.
- The card's copy drops "in this turn".

33cbcc5e adds the errored-turn case. Docs: the stamp table in `assistant.md § The write approval card` was updated, and the Assistant table in troubleshooting.md gains a row.
