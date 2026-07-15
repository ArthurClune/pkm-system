---
# pkm-1cq3
title: Consolidate reference and TODO grammar scanning
status: todo
type: task
priority: normal
tags:
    - web
    - grammar
    - fcis
created_at: 2026-07-15T14:23:27Z
updated_at: 2026-07-15T14:23:27Z
parent: pkm-c1cg
---

## Goal

Remove duplicated balanced-reference and TODO-marker parsing across tokenizer, reference extraction, caret lookup, slash commands, and TODO toggling.

## Acceptance criteria

- [ ] A shared pure scanner returns stable spans/tokens with offsets.
- [ ] tokenize.ts, refs.ts, and refAtCaret.ts derive behavior from the shared scanner.
- [ ] TODO marker parsing is centralized and reused by tokenization, commands, and toggling.
- [ ] Malformed, nested, overflow, and round-trip cases have shared contract tests.
- [ ] Public behavior remains compatible unless an intentional change is documented.
- [ ] pnpm verify passes.
