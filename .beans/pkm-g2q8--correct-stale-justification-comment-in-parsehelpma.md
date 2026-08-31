---
# pkm-g2q8
title: Correct stale justification comment in parseHelpMarkdown.ts
status: completed
type: task
priority: normal
created_at: 2026-08-31T19:01:23Z
updated_at: 2026-08-31T19:03:09Z
---

The header comment in web/src/help/parseHelpMarkdown.ts justifies the standalone /help parser by claiming the app block grammar would linkify literal [[page]]/((...)) inside backticks. That claim is stale: grammar/scan.ts blanks code spans before any reference recognition. The real justification is that the app grammar is inline-only over a single block's text — it has no block-level pass (headings, paragraphs, pipe tables), which is what docs/keyboard.md needs — plus the deliberate no-markdown-dependency stance. Fix the comment; no behaviour change.

- [x] Rewrite header comment with the accurate justification
- [x] Typecheck web
- [x] Commit bean + change

## Summary of Changes

Rewrote the header comment in web/src/help/parseHelpMarkdown.ts. The old justification (app grammar would linkify literal [[page]]/((...)) inside backticks) was stale — grammar/scan.ts blanks code spans before reference recognition. The comment now gives the accurate reasons: the app grammar is inline-only over a single block's text with no block-level pass (headings/paragraphs/pipe tables), and the no-markdown-dependency stance. Comment-only change; pnpm typecheck exit 0, unit tests green.
