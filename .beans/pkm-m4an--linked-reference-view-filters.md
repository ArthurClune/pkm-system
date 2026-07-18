---
# pkm-m4an
title: Linked reference view filters
status: completed
type: feature
priority: normal
created_at: 2026-07-14T19:43:08Z
updated_at: 2026-07-18T13:17:17Z
---


In the "Linked References" section at the end of a page, we should be able to filter on attributes (e.g. filter out '#Paper'). Targets should be to filter on any page reference/tag. No need to filter at a lower level. So if we're on the 'Claude' page, one backlink that will show is

[Constitutional Classifiers++: Efficient Production-Grade Defenses against Universal Jailbreaks](https://arxiv.org/abs/2601.04603) #Paper #Claude #[[Constitutional AI]]

and we should be able to filter for/filter out this on '#Paper', '#[[Constitutional AI]]' etc

## Design

Spec: `docs/superpowers/specs/2026-07-18-linked-refs-filter-design.md` —
Roam-style chip panel, ephemeral, fully client-side (load-all backlinks on
panel open, filter via `extractRefs` over item text + breadcrumb ancestors).

## Summary of Changes

### Functional Core: backlinkFilter.ts
- Pure logic module for extracting and filtering references (tags, page links, ancestors)
- Core functions: `extractRefs()` (parses block text and breadcrumb tags), `applyFilter()` (includes/excludes refs based on filter state)
- No I/O or side effects; fully testable

### Filter Panel UI: BacklinksSection.tsx
- Chip-based filter interface in the Linked References section
- Include/exclude toggle chips for each detected reference (shift-click to exclude, click to include)
- N-of-M header showing filtered count vs total (e.g., "5 of 12 references")
- Clear filters button to reset state
- Load-all pagination: when the panel opens, fetches all backlinks (not paginated in the feed view)
- Ephemeral state: filters are computed client-side, no server persistence

### Styling: CSS Chips
- Chip styles in `web/src/styles.css` using reusable design tokens (`--radius-*`, `.chip`, `.chip-include`, `.chip-exclude`)
- Consistent with design system (buttons, sidebar, cards)

### Tests
- **Unit tests** (`backlinkFilter.test.ts`): extractRefs and applyFilter functions, edge cases (nested brackets, multiple tags, ancestors)
- **Component tests** (`sections.test.tsx`): BacklinksSection render, filter state updates, chip interactions, clear function
- **E2E spec** (`e2e/backlink-filter.spec.ts`): end-to-end test verifying include/exclude toggles, filter persistence across interactions, N-of-M header updates

All verification stages pass: typecheck, lint, FCIS, unit coverage, build, E2E (15/15 tests pass).
