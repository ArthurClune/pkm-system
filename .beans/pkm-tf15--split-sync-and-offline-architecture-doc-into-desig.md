---
# pkm-tf15
title: Split sync-and-offline architecture doc into design and failure-modes/recovery docs
status: todo
type: task
created_at: 2026-09-28T19:12:42Z
updated_at: 2026-09-28T19:12:42Z
---

`docs/architecture/sync-and-offline.md` mixes two audiences: how sync is designed (replica, op queue, changes feed, nudges, snapshots) and the long tail of edge cases, guards and recovery paths that have accreted with each fix (fallback lane precedence, availability latch, window strikes, corruption reset and file replacement, pending-id guard, rollback error masking, poison repair ownership...). The design is hard to see through the guards.

Arthur's direction (2026-09-28): split it into two docs.

1. **Design** — the system as a newcomer needs it: components, data flow, the write path, the read/pull path, bootstrap, reconnect. Diagrams first.
2. **Failure modes and recovery** — every guard and recovery pattern, keyed by the failure it handles: what detects it, what the response is, which invariant must hold, and where the code lives. Tables over prose.

`docs/troubleshooting.md` stays the symptom-keyed index and links into doc 2.

## Todo
- [ ] Inventory every section of sync-and-offline.md as design vs guard/recovery
- [ ] Agree names and the split line with Arthur
- [ ] Write the design doc (diagram-led) and the failure-modes doc (table-led), via the architecture-docs skill
- [ ] Repoint inbound links: troubleshooting.md Where column, sibling docs, AGENTS.md doc list
- [ ] Verify each claim against the code, not against the old prose
- [ ] check-docs.mjs clean on both files
