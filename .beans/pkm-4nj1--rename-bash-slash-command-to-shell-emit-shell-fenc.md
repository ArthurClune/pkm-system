---
# pkm-4nj1
title: Rename /bash slash command to /shell (emit ```shell fences)
status: completed
type: task
priority: normal
created_at: 2026-08-19T10:37:12Z
updated_at: 2026-08-19T10:40:26Z
---

Standardise on /shell: the slash menu's 'bash code block' command (which wraps in a ```bash fence) becomes /shell, 'shell code block', wrapping in ```shell. hljs common registers 'shell' so highlighting works. Follow-up (separate, needs Arthur's confirmation): migrate graph content — ```bash fences to ```shell, and bare ``` fences whose lines start with $ to ```shell.

- [x] slashCommands.ts: name/label + fence case
- [x] slashCommands.test.ts updated (TDD)
- [x] docs/keyboard.md row updated (slashCommandsDocumented drift test)
- [x] pnpm verify green (54 e2e passed)

## Summary of Changes

Renamed the /bash slash command to /shell: the menu entry is now 'shell code block' and the transform wraps in a ```shell fence (hljs common's shell grammar, which highlights $-prefixed session transcripts). /bash no longer matches. Updated slashCommands.ts, its tests, and the docs/keyboard.md row (kept in sync by slashCommandsDocumented.test.ts). Graph content migration (```bash → ```shell, $-prefixed bare fences → ```shell) handled separately with Arthur's confirmation.
