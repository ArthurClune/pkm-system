---
# pkm-qotb
title: 'Staleness stamp: a stopped turn''s in-flight write is forgotten by the next turn'
status: todo
type: bug
priority: low
created_at: 2026-10-25T02:20:05Z
updated_at: 2026-10-25T02:20:05Z
parent: pkm-mfd0
---

From the pkm-g2w9 final re-review (2026-10-25). The assistant's send() clears the running-writes set at the start of each turn. If a turn was stopped or timed out while an allowed write was still in flight, the next turn's first approval card can read its target before that write lands and carry no writes_in_flight stamp, so no staleness marker shows.

- [ ] Red test: stop a turn with an allowed write running; next turn's first card is stamped
- [ ] Clear each write from the set when it finishes, not at turn start
- [ ] troubleshooting.md row
