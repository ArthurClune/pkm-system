---
# pkm-fwa2
title: Rework outline paste UX (post-revert)
status: todo
type: feature
created_at: 2026-07-27T21:39:56Z
updated_at: 2026-07-27T21:39:56Z
---

pkm-tu3a shipped hierarchy-preserving paste but was reverted the same evening (revert commit aebc108 of merge adf8c80): splitting multi-line NON-indented text into multiple blocks was not clearly an improvement in live use — e.g. prose or text meant to live inside a single block. Arthur wants to experiment with exactly how paste should behave before re-landing.

Ideas raised so far:
- Only intercept clipboards with real outline structure (indented lines), leaving flat multi-line text in one block — i.e. tighten the isOutlinePaste predicate further than the shipped >1-node rule.
- Trap Shift-Cmd-V as an explicit 'paste into single block' escape hatch (or invert: plain paste stays native, Shift-Cmd-V does the outline split).
- Consider what /text blocks and similar should do with multi-line pastes.

The full reverted implementation (parser, planner, shell wiring, tests, e2e, spec + plan docs) lives in history at branch commits 3a4f344..040f34c / merge adf8c80 — re-land by reverting the revert, then adjust the interception policy on top. Critical constraint learned in final review (recorded in memory outline-paste-tu3a-shipped): any splice-only path that tree-directly updates the FOCUSED block's text fights BlockInput dirty-draft adoption — single-block paste variants must ride the draft path.
