---
# pkm-eceh
title: Split model-backed architecture docs into design docs and contracts/
status: completed
type: task
priority: normal
created_at: 2026-11-12T14:38:22Z
updated_at: 2026-11-12T15:16:45Z
---

Property models are written from the architecture docs, so their case tables could not be cut, and the design prose around them reads dense. Move every input→outcome table a model encodes into docs/architecture/contracts/<doc>.md; the design doc keeps orientation, diagrams, principles and a link per mechanism. Contract files carry their own writing rules (exhaustive, stable row names, no orientation). Tables no model uses stay put. State diagrams stay in the design doc; the contract links to them.

- [x] write-path.md → contracts/write-path.md; retarget server/tests/props citations
- [x] Arthur reviews the write-path pair
- [x] sync-and-offline.md, sync-recovery.md → contracts/ (one file each, named after its doc)
- [x] frontend.md, frontend-editor.md, assistant.md → contracts/
- [x] checks.md § Property gate: models are written from contracts/
- [x] architecture-docs skill: Contract files section; overview.md index
- [x] check-docs clean

## Summary of Changes

Each model-backed architecture doc is now a design doc plus a contract file under `docs/architecture/contracts/`, named after it, with the same section names: write-path, sync-and-offline, sync-recovery, frontend, frontend-editor, assistant. The contract holds the case tables a property model is written from, and a reason particular to one row. The design doc keeps orientation, diagrams, and each section's principle with its reason. Case tables no model reads stayed in the design docs. Model, test and server comments cite the contract sections they encode. `checks.md` § Property gate says a model's cases come from `contracts/`.

- **Skill:** `architecture-docs` gained § Contract files: the shape of a contract, tightening keeps every case, and a behaviour change is one commit of row, model and model tests. It was tested with subagents. Without it, 3/3 runs cut contract cases and 0/3 updated the model. With it, 0/3 cut cases and 3/3 updated the model, holding on a re-test after the reason rule was added.
- **Checker:** `check-docs.mjs` counts an untracked checked file towards its own basename, so a new same-named contract no longer claims bare citations.
- **Corrected:**
  - An edit to a gone block with blank text lands nothing. The old Conflicts prose said "blank or not" for both cases, while the code (`classify_skip`) and the Missing targets table land nothing for a blank orphan edit.
  - The subtree-hash canonical form is `subtree_hash`, not a section of sync-and-offline.md.
- **Added while splitting, each checked against the code:**
  - ShiftSiblings bumps siblings of the same page and parent, by one.
  - Hashless and matching `delete` rows.
  - An `update_text`'s `page_title` is never title-checked.
  - The poison-over-outline ranking holds while the replica is present.
  - assistant.md states that a stop heard while the prompt is still being written has no server-side bound.
- **Follow-up:** pkm-k2lf, for the cases models still take from design prose or the code.
