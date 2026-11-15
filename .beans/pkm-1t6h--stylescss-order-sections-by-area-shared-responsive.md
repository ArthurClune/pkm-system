---
# pkm-1t6h
title: 'styles.css: order sections by area, shared Responsive last (keep one file)'
status: todo
type: task
created_at: 2026-11-15T21:39:27Z
updated_at: 2026-11-15T21:39:27Z
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

- [ ] Group sections by area (tokens and base, layout and chrome, outline and
      editing, inline content and media, references and search, feature
      surfaces such as Assistant and Files), keeping tokens and themes first
- [ ] Move the shared `Responsive` section to the end of the file; sections
      with their own `@media` keep it right after the rules it overrides
- [ ] Merge "References" and "References, continued"; place
      "Linked-references filter" beside them
- [ ] Rehome the "Carry-forwards" rules and delete the section
- [ ] Confirm no rule's winner changes: every moved rule either has no
      equal-specificity competitor for the same element and property, or
      keeps its relative order with that competitor. Diff computed styles on
      the main views at desktop and phone widths before and after (verify
      skill), light and dark
- [ ] Add a `styles.test.ts` check for the invariants: section marker names
      are unique, and the shared `Responsive` section is the last one
- [ ] Update `docs/architecture/styling.md` (section order rule, Responsive
      last) via the `architecture-docs` skill
- [ ] `pnpm verify`; `perf/check.sh frontend`

## Out of scope

Splitting into partials (`@import`), CSS modules, or renaming classes. Revisit
partials only if merge conflicts in `styles.css` keep costing time after the
reorder.
