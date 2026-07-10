---
# pkm-x3so
title: 'Slash-command block handling: /Text broken, tab-complete missing, code blocks should wrap'
status: completed
type: bug
priority: normal
created_at: 2026-07-10T16:43:18Z
updated_at: 2026-07-10T17:40:49Z
---

A set of bugs and improvements around inserting and displaying text/code blocks via the slash menu.

- [x] '/Text' doesn't work at all: start typing it, click on it — no response. Should insert a text block.
- [x] '/Python code block' works when clicked, but tab-completion of the slash menu doesn't work and should (Tab accepts the highlighted entry).
- [x] Code blocks (e.g. Python) should wrap long lines rather than showing horizontal scroll bars.
- [x] Tests for slash-menu selection (click and Tab) and block insertion

## Summary of Changes

**`/text` (`web/src/outline/slashCommands.ts`):** the old `applySlashCommand` case
for `"text"` just called `unwrapFence(content)`, which is a no-op unless the
block is already a whole fence — so picking "Text" only stripped the "/text"
trigger and appeared to do nothing. Replaced it with a new `textBlock()`
helper that unwraps the content first (if it's already a whole fence, of any
language) and then re-wraps it via `wrapFence(content, "")` — a fence with no
language tag. `parseFence` (tokenize.ts) turns a lang-less fence into a
code-block with `lang: null`, which `CodeBlock` renders unhighlighted: that's
the "text block". Cursor lands inside the fence, same as the code-block
commands. Updated the file's header comment to document the new semantics.
Updated the three `/text` unit tests in `slashCommands.test.ts` (empty block,
block with plain content, block that's already a whole Python fence) to match.

**Tab-completion:** investigated first per the process requirements before
changing anything — `EditableBlockTree.tsx`'s `onKeyDown` already handles
`e.key === "Enter" || e.key === "Tab"` by calling `pick(acRows[acSelected])`
whenever the popup has rows, *before* falling through to the plain-Tab
indent/outdent branch further down. Added a regression test
("Tab accepts the highlighted slash-menu row...") that types `/py`, presses
Tab, and asserts the draft became `` ```python\n\n``` `` and `onIndent` was
NOT called. The test passes unmodified against HEAD — Tab-accept already
worked. No production code changed for this item; the bean's premise (Tab
doesn't work) wasn't reproducible. Kept the test as a permanent regression
guard.

**Code-block wrapping (`web/src/styles.css`):** `.code-block` had
`overflow-x: auto`, so long lines showed a horizontal scrollbar instead of
wrapping. Replaced it with `white-space: pre-wrap; overflow-wrap: anywhere;`
(dropped `overflow-x: auto`, now unnecessary since content wraps instead of
overflowing). No conflicting `overflow-x`/`white-space` rules existed
elsewhere in the stylesheet.

**Tests added** (`web/src/components/EditableBlockTree.test.tsx`): click-pick
of a slash-menu row (mouseDown on the "Python code block" option inserts a
python fence), the Tab regression test above, and `/text` on an empty block
inserting `` ```\n\n``` ``. Pure unit tests added/updated in
`slashCommands.test.ts` for `/text`'s three cases.

**Verification:** `pnpm test -- --run` → 40 files, 298 tests, all passing.
`pnpm typecheck` → clean.
