---
# pkm-9ljt
title: Assistant panel shows ✓ on a batch that skipped some ops
status: todo
type: feature
priority: low
created_at: 2026-10-25T18:39:40Z
updated_at: 2026-10-25T18:39:40Z
parent: pkm-mfd0
---

From the pkm-0214 final review (M2, 2026-10-25). render_ops_ack returns 'warning: skipped N of M ops …' as a successful tool result (e.g. a move under its own descendant, a create whose heading parent is gone), so is_error is false and the panel shows ✓ while the model can say 'done'. The ops were approved on the card, so this is outside 'refused or failed', but the ✓ overstates what happened.

- [ ] Surface a warning: result on the tool line (e.g. a distinct mark and the warning text, rendered as text)
- [ ] Docs: assistant.md § A write's result
