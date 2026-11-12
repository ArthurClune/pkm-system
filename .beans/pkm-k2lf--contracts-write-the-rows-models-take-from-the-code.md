---
# pkm-k2lf
title: 'Contracts: write the rows models take from the code'
status: completed
type: task
priority: normal
created_at: 2026-11-12T15:03:03Z
updated_at: 2026-11-12T16:02:43Z
---

Where a property model says the docs are silent and it follows the code ('(code, not docs)' markers in server/tests/props/model.py and the web models), add the case as a contract row in docs/architecture/contracts/, checked against the code, and point the model's comment at it. Includes a 'visible rows' contract for web/src/props/outline/visibleTree.ts, whose model reads two rows of frontend-editor.md § Rules an edit must not break and follows tree.ts for invalid table macros and view modes. Each new row is a claim, so commits say 'added'.

- [x] server/tests/props/model.py '(code, not docs)' cases
- [x] web models' doc-silent cases
- [x] visible-rows contract for visibleTree.ts
- [x] draftModel.ts: the draft's base and when the textarea adopts the tree's text (now read from frontend-editor.md § Drafts and commit points)
- [x] assistant model.ts: 'after Stop no output of that turn reaches the panel' (now read from frontend.md § The chat machine)
- [x] model.py: the op table cells and one-transaction-per-batch (now read from write-path.md); backend.md § Database and cli-and-mcp.md § Pure planners rows
- [x] bannerModel.ts: poison ranks over a stalled replica's banner while the replica is there (no row anywhere)


## Triage before writing (agreed with Arthur 2026-11-12)

Each code-derived case is sorted before a row is written:
- intended rule -> contract row, checked against the code
- bug -> bug bean, no row
- accident nobody depends on -> the model stops asserting it; no row, no marker

Reading the code to check a row is required; what the property gate forbids is the code being the model's only source, which makes the property check the code against itself.

- [x] Accident/bug candidates put to Arthur (2026-11-12): blank-title stale mismatch ignored (fine); older-copy-wins -> pkm-7a8u; stall banner lost -> pkm-3kwx; poison-beside-stall model -> pkm-dr4j; revealed-table cell and repaired-over-stalled rows kept
- [x] checks.md § Property gate and architecture-docs SKILL.md § Contract files state the triage


## Summary of Changes

Every case the property models took from the code or from the `<doc>.md` design prose is now a contract row, triaged first (intended / bug / accident). New: contracts/backend.md § Database, contracts/cli-and-mcp.md § Pure planners, write-path.md `## Ops` plus contracts/write-path.md § Ops, the visible-rows rows in contracts/frontend-editor.md § Rules an edit must not break, and rows for drafts, Keyboard policy, Stop and the poison/stall banner. checks.md § Property gate holds the triage table. `test_written_out_limits_match_the_server` pins the model's written-out limits (MAX_REPLAY_STEPS, UNTITLED, TEXT_CAP, NESTING_CAP) to the server's. The `classify_text_edit` table now follows the code's check order, including the blind walk.

Left: the `Model._record` older-copy-wins marker (pkm-7a8u), the banner model's poison-beside-stall gap (pkm-dr4j), and a stalled replica losing its banner when a poison problem ends (pkm-3kwx). Arthur ruled that the blank-title stale-check mismatch is fine.
