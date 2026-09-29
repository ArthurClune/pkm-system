---
# pkm-nny8
title: 'Hash-guarded delete: a stale delete over an unseen edit preserves the text under the daily-note conflict header'
status: draft
type: feature
priority: normal
created_at: 2026-09-29T13:20:56Z
updated_at: 2026-09-29T13:20:56Z
parent: pkm-a4t2
---

Decision (Arthur, 2026-09-29), from the review's policy question. The
offline-editing spec (`docs/superpowers/specs/2026-07-12-offline-editing-design.md`)
makes structural ops plain last-writer-wins, so a `delete` arriving after an
edit it never saw removes that edit with no conflict copy. The reverse order
is safe (the edit becomes an orphan edit on the daily note), so the outcome
depends on arrival order. `delete` is the only structural op that destroys
text. Realistic trigger: a device deletes a block while offline and another
device edited it meanwhile.

Sketch approved in conversation: the `delete` op gains an optional base hash
of the subtree it deletes, stamped where `update_text`'s hash is stamped
(`stampBaseTextHashes` on the main thread; the worker fills it when absent).
The server planner compares it with the current subtree. On a match the
delete applies as now. On divergence the delete still wins (who wins is
unchanged) and the server's current texts for that subtree land as children
under the block's daily-note conflict header (pkm-3g4n's machinery). Replicas
need nothing new: the client's own delete applies locally as today and the
conflict entry arrives over the feed. The CLI and MCP guarded delete pass the
fetched hash as the guarded update does. Cost: a subtree delete that raced an
edit puts the whole subtree's texts in the daily note, since one hash cannot
say which descendant changed.

Draft: needs its own brainstorm and spec, after F1 to F4 land. Until it
ships, the docs state the stale-delete limit as open, not accepted.
