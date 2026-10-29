---
# pkm-9ljt
title: Assistant panel shows ✓ on a batch that skipped some ops
status: completed
type: feature
priority: low
created_at: 2026-10-25T18:39:40Z
updated_at: 2026-10-29T17:00:21Z
parent: pkm-mfd0
---

From the pkm-0214 final review (M2, 2026-10-25). render_ops_ack returns 'warning: skipped N of M ops …' as a successful tool result (e.g. a move under its own descendant, a create whose heading parent is gone), so is_error is false and the panel shows ✓ while the model can say 'done'. The ops were approved on the card, so this is outside 'refused or failed', but the ✓ overstates what happened.

- [x] Surface a warning: result on the tool line (e.g. a distinct mark and the warning text, rendered as text)
- [x] Docs: assistant.md § A write's result



## Summary of Changes

A successful write result that begins "warning:" now sets `ToolFinished.warning` (first line, clipped) in the assistant event mapper; the web SSE types carry the optional field and the panel shows a warning mark plus the text (text only) on the tool line. Errors and declined results never carry it. Pinned by `test_claude_engine.py` (including a negative test for error and declined results), `test_assistant_events.py` (wire key present as null or string), `sse.test.ts`, `useAssistant.test.tsx` and `AssistantPanel.test.tsx`. Docs: assistant.md (a write result), frontend.md, styling.md, a troubleshooting row. Left as is: `ChatItem.warning` stays optional (`warning?: string`) rather than `string | null`, and a declined non-error result carrying a warning is unreachable today. No property gate: nothing in its scope changed.
