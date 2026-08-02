---
# pkm-mlbh
title: Split BlockInput tests out of EditableBlockTree.test.tsx
status: completed
type: task
priority: low
created_at: 2026-08-01T18:05:52Z
updated_at: 2026-08-02T17:59:03Z
parent: pkm-6phf
---

Follow-up to pkm-64bq: after the BlockInput extraction, roughly half of EditableBlockTree.test.tsx's 111 tests exercise BlockInput. Move them to a BlockInput.test.tsx as a standalone test-only change (deliberately not done during the refactor so the safety net stayed byte-stable).

- [x] Move the BlockInput-facing tests, no assertion changes

## Summary of Changes

Moved 70 focused textarea, draft, autocomplete, keyboard, navigation, paste, and date-picker tests into a direct BlockInput suite. Retained 42 tree-owned rendering, upload-input, selection, menu, fallback, and table tests. All 112 test names/assertions remain covered.
