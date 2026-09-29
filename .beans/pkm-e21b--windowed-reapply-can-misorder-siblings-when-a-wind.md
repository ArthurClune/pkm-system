---
# pkm-e21b
title: Windowed reapply can misorder siblings when a window re-ships some of them
status: todo
type: bug
priority: low
created_at: 2026-09-29T09:56:19Z
updated_at: 2026-09-29T09:56:19Z
---

Residual from pkm-b0zf. A windowed `reapplyPending` replays pending batches over their own optimistic effects. `keepSlot` (localOps.ts) stops the sibling-shift drift, but when a window re-ships only some siblings, at their server order_idx, into a list that holds locally shifted indices, the replay can misorder them.

Example: pending create C1 at idx 0, then pending create C2 at idx 0, so locally C2=0, C1=1, S=2. Another device edits S before our ack, and the window re-ships S at its server idx 0. Replay: C1 sits at 1 with no clash, so it is kept. C2 sits at 0 and clashes with S, so everything from 0 up except C2 shifts. Result: C2, S, C1, where the intent was C2, C1, S. It lasts until the ack/echo re-ships the true order. Before pkm-b0zf the same case gave a C2/S tie.

The same limit applies to a block moved twice by pending ops (the first move's replay re-shifts).

A proper fix undoes pending effects before the window's upsert, e.g. by keeping pre-images of rows that pending ops touched, then replaying from window state. That is a replica schema change. Low priority: it needs a remote edit to a sibling inside the ack window, and it self-heals on the echo.

- [ ] Decide whether it is worth a schema change
- [ ] Failing test for the example above
