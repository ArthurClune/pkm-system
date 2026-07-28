---
# pkm-fwa2
title: Rework outline paste UX (post-revert)
status: in-progress
type: feature
priority: normal
created_at: 2026-07-27T21:39:56Z
updated_at: 2026-07-28T06:00:53Z
---

pkm-tu3a shipped hierarchy-preserving paste but was reverted the same evening (revert commit aebc108 of merge adf8c80): splitting multi-line NON-indented text into multiple blocks was not clearly an improvement in live use — e.g. prose or text meant to live inside a single block. Arthur wants to experiment with exactly how paste should behave before re-landing.

Ideas raised so far:
- Only intercept clipboards with real outline structure (indented lines), leaving flat multi-line text in one block — i.e. tighten the isOutlinePaste predicate further than the shipped >1-node rule.
- Trap Shift-Cmd-V as an explicit 'paste into single block' escape hatch (or invert: plain paste stays native, Shift-Cmd-V does the outline split).
- Consider what /text blocks and similar should do with multi-line pastes.

The full reverted implementation (parser, planner, shell wiring, tests, e2e, spec + plan docs) lives in history at branch commits 3a4f344..040f34c / merge adf8c80 — re-land by reverting the revert, then adjust the interception policy on top. Critical constraint learned in final review (recorded in memory outline-paste-tu3a-shipped): any splice-only path that tree-directly updates the FOCUSED block's text fights BlockInput dirty-draft adoption — single-block paste variants must ride the draft path.

## Decision (2026-07-28)

Arthur decided: **plain Cmd-V stays fully native** (never intercepted, regardless
of clipboard shape); **Shift-Cmd-V (Ctrl-Shift-V on non-Mac) performs the outline
split** using the re-landed pkm-tu3a parser/planner. A ClipboardEvent carries no
modifier state, so the chord's keydown arms a shell-side flag that the next paste
event consumes; any other keydown (or blur) clears it. Shift-Cmd-V with a
single-line clipboard stays native too (isOutlinePaste structure gate kept — a
tree-direct update_text on the focused block would fight dirty-draft adoption).

## Plan

- [ ] Re-land tu3a implementation (revert the revert) on branch pkm-fwa2-outline-paste
- [ ] Core: isOutlinePasteChord predicate in paste.ts (tests first)
- [ ] Shell: arm-on-chord / clear-on-other-keydown-or-blur ref in BlockInput; onPaste requires armed
- [ ] Shell unit tests updated for armed/unarmed paths
- [ ] e2e: arm via synthetic keydown before paste; new test that plain multi-line paste is NOT intercepted
- [ ] Docs: keyboard.md Shift-Cmd-V row; spec doc updated with fwa2 policy
- [ ] cd web && pnpm verify
- [ ] Merge --no-ff, deploy, verify prod HEAD
