---
# pkm-k2lf
title: 'Contracts: write the rows models take from the code'
status: todo
type: task
priority: normal
created_at: 2026-11-12T15:03:03Z
updated_at: 2026-11-12T15:12:04Z
---

Where a property model says the docs are silent and it follows the code ('(code, not docs)' markers in server/tests/props/model.py and the web models), add the case as a contract row in docs/architecture/contracts/, checked against the code, and point the model's comment at it. Includes a 'visible rows' contract for web/src/props/outline/visibleTree.ts, whose model reads two rows of frontend-editor.md § Rules an edit must not break and follows tree.ts for invalid table macros and view modes. Each new row is a claim, so commits say 'added'.

- [ ] server/tests/props/model.py '(code, not docs)' cases
- [ ] web models' doc-silent cases
- [ ] visible-rows contract for visibleTree.ts
- [ ] draftModel.ts: the draft's base and when the textarea adopts the tree's text (now read from frontend-editor.md § Drafts and commit points)
- [ ] assistant model.ts: 'after Stop no output of that turn reaches the panel' (now read from frontend.md § The chat machine)
- [ ] model.py: the op table cells and one-transaction-per-batch (now read from write-path.md); backend.md § Database and cli-and-mcp.md § Pure planners rows
- [ ] bannerModel.ts: poison ranks over a stalled replica's banner while the replica is there (no row anywhere)
