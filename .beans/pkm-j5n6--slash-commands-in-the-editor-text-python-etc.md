---
# pkm-j5n6
title: Slash commands in the editor (/text, /python, etc.)
status: completed
type: feature
priority: normal
created_at: 2026-07-09T18:54:26Z
updated_at: 2026-07-09T21:26:18Z
---

Add slash-command support in the block editor. Typing / should open a command menu — mainly /text, /python and similar block-type commands to start.

## Summary of Changes

Extended the existing `[[`/`#` autocomplete machinery with a third trigger kind, `"command"`, rather than building a parallel popup system:

- `web/src/outline/autocomplete.ts`: `AcContext.kind` gained `"command"`. `detectAutocomplete` now also matches a `/` at block start or after whitespace, followed by letters only (`SLASH_QUERY_RE`). A bare `/` triggers with an empty query (opens the menu immediately, per the ask); a space/punctuation/newline right after the slash closes it, which also keeps it quiet inside URLs (`https://…`) and paths (`path/to/x`) since those slashes are glued to the previous character.
- `web/src/outline/slashCommands.ts` (new, Functional Core): the static command list (`SLASH_COMMANDS`: text, todo, python, bash, javascript) with prefix filtering (`matchSlashCommands`), and `applySlashCommand`, which strips the `/query` trigger and applies each command's transform:
  - `/python` `/bash` `/javascript`: wrap the block's remaining content in a ` ```lang\n…\n``` ` fence (cursor lands right before the closing fence).
  - `/text`: if the block *is* a whole-block fence (matches `` ```lang\n…\n``` `` anchored end-to-end), unwrap it back to the plain code content; otherwise it's a no-op beyond removing the trigger.
  - `/todo`: prefixes `{{TODO}} ` (the exact marker tokenize.ts's `TODO_PREFIX` regex expects), and doesn't double-prefix an already-TODO block.
- `web/src/components/AutocompletePopup.tsx`: `AcRow` gained an optional `command?: string` field.
- `web/src/components/EditableBlockTree.tsx`: `BlockInput` now skips the titles-API fetch for `"command"` contexts (rows come from `matchSlashCommands` instead of `useTitleOptions`/`buildRows`), and `pick()` dispatches to `applySlashCommand` when the picked row carries a `command`. All existing keyboard nav (arrows/Enter/Tab/Escape) is reused as-is.

**Headings (/h1 /h2 /h3) were deferred**, tracked as a follow-up: **pkm-kiip**. Investigated whether any existing op path can set `heading` on an existing block — it can't: `CreateOp` carries `heading` but only applies it at insert time (`server/src/pkm/server/ops_apply.py:78-81`); `UpdateTextOp` has no `heading` field and there is no `SetHeadingOp`. Per the task's constraint not to add new server ops for this feature, heading commands are out of scope here.

**Tests**: 21 new unit tests (`slashCommands.test.ts`, additions to `autocomplete.test.ts`) covering command matching, each transform (fence wrap/unwrap, TODO prefix, no-op cases), and slash-trigger detection including the URL/path/mid-word exclusions. Plus 3 new wiring tests in `EditableBlockTree.test.tsx` (menu opens and filters, Enter applies a code-fence transform, arrow-nav picks a filtered command, non-matching query falls through to normal Enter/split behavior). Full suite: 174 tests passing, 28 files. `pnpm typecheck` clean.
