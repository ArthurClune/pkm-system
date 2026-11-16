---
# pkm-1t6h
title: 'styles.css: order sections by area, shared Responsive last (keep one file)'
status: completed
type: task
priority: normal
created_at: 2026-11-15T21:39:27Z
updated_at: 2026-11-16T08:27:05Z
---

`web/src/styles.css` stays one file: one file keeps the cascade order visible
in one place, and `styles.test.ts` and the verify skill's "Known selectors"
table read it as one file. What needs fixing is its internal order, which has
drifted from "by area" to "by date added".

## What is wrong (checked 2026-11-15)

- **The shared `Responsive` section is not last.** `styling.md` says an
  override must follow the rule it overrides, and a media query adds no
  specificity. About a dozen sections come after `Responsive` (Carry-forwards,
  Sync, Editor, Autocomplete, Date picker, Block menu, Empty page, Keyboard
  bar, Drag and drop, Assistant, Files, Local file picker, Find bar). A
  breakpoint override added to `Responsive` for any of their selectors loses
  silently at equal specificity. Today none of them restyles a selector that
  `Responsive` overrides, so this is a trap, not a live bug.
- **Sections are split and appended.** "References" is interrupted by
  "Linked-references filter" and resumes as "References, continued". Editor
  and Autocomplete sit far from Outline rows and Inline content. The tail
  (Assistant, Files, Local file picker, Find bar) is in the order it was
  written.
- **"Carry-forwards" has no area of its own.** It holds `.error-screen`,
  `.not-found` and `.journal-status`, which belong in existing sections.
- New work keeps appending at the end, so parallel branches collide there.

## Aim

A reader can predict which section a rule lives in from the component it
styles, and a responsive override in the shared section always wins. Nothing
renders differently: this is a reorder, not a restyle.

## Checklist

- [x] Group sections by area (tokens and base, layout and chrome, outline and
      editing, inline content and media, references and search, feature
      surfaces such as Assistant and Files), keeping tokens and themes first
- [x] Move the shared `Responsive` section to the end of the file; sections
      with their own `@media` keep it right after the rules it overrides
- [x] Merge "References" and "References, continued"; place
      "Linked-references filter" beside them
- [x] Rehome the "Carry-forwards" rules and delete the section
- [x] Confirm no rule's winner changes: every moved rule either has no
      equal-specificity competitor for the same element and property, or
      keeps its relative order with that competitor. Diff computed styles on
      the main views at desktop and phone widths before and after (verify
      skill), light and dark
- [x] Add a `styles.test.ts` check for the invariants: section marker names
      are unique, and the shared `Responsive` section is the last one
- [x] Update `docs/architecture/styling.md` (section order rule, Responsive
      last) via the `architecture-docs` skill
- [x] ~~`pnpm verify`; `perf/check.sh frontend`~~ waived by Arthur for a layout-only change; lint, tsc and `styles.test.ts` run instead

## Out of scope

Splitting into partials (`@import`), CSS modules, or renaming classes. Revisit
partials only if merge conflicts in `styles.css` keep costing time after the
reorder.

## Summary of Changes

`web/src/styles.css` sections now run by area: tokens and base, layout and
chrome, outline and editing, inline content and media, references and search,
pages and feature surfaces, with the shared Responsive section last. Each
section kept its relative order where it could, to keep cascade flips few.
"References, continued" merged into "References" with
"Linked-references filter" after it. "Carry-forwards" is gone: `.error-screen`
and `.not-found` went to Status and notices, `.journal-status` to Journal. No
declaration changed; the file's lines are the same multiset bar the two
removed markers.

Winner check: done statically instead of by computed-style diff. A postcss
script listed every pair of rules whose relative order flipped, at equal
specificity, setting an overlapping property. Pairs that could hit the same
element (shared class, or both classes named in one source file) were
checked against the markup; none lands on one element, so no rule's winner
changed.

`styles.test.ts` pins unique section names, Tokens and themes first and
Responsive last (it fails on the old file, whose last section was
"Find bar"). `styling.md` states the area order and the Responsive-last rule.

Verification, as agreed with Arthur for a layout-only CSS change: eslint,
tsc, comment lint, check-docs and `styles.test.ts`; no full `pnpm verify`,
perf or proptest run.

