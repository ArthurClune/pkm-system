---
# pkm-eceh
title: Split model-backed architecture docs into design docs and contracts/
status: in-progress
type: task
priority: normal
created_at: 2026-11-12T14:38:22Z
updated_at: 2026-11-12T14:43:14Z
---

Property models are written from the architecture docs, so their case tables could not be cut, and the design prose around them reads dense. Move every input→outcome table a model encodes into docs/architecture/contracts/<doc>.md; the design doc keeps orientation, diagrams, principles and a link per mechanism. Contract files carry their own writing rules (exhaustive, stable row names, no orientation). Tables no model uses stay put. State diagrams stay in the design doc; the contract links to them.

- [x] write-path.md → contracts/write-path.md; retarget server/tests/props citations
- [ ] Arthur reviews the write-path pair
- [ ] sync-and-offline.md + sync-recovery.md → contracts/sync.md
- [ ] frontend.md, frontend-editor.md, assistant.md → contracts/
- [ ] checks.md § Property gate: models are written from contracts/
- [ ] architecture-docs skill: Contract files section; overview.md index
- [ ] check-docs clean
