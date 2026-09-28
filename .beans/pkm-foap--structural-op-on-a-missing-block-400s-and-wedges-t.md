---
# pkm-foap
title: Structural op on a missing block 400s and wedges the queue
status: todo
type: bug
created_at: 2026-09-28T19:50:15Z
updated_at: 2026-09-28T19:50:15Z
---

A move/set_heading/set_collapsed whose uid the server does not have returns 400 (block not found), which poisons the batch and blocks every later op behind a 'Server rejected a change' banner (seen 2026-09-28 with a move of a never-created block). Consider dropping such ops with a conflict note in the daily note (see the conflicts-in-daily-note spec) instead of rejecting. Needs design.
