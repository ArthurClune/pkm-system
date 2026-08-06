---
# pkm-7iv7
title: Block-ref popover renders off the right viewport edge
status: completed
type: bug
priority: normal
created_at: 2026-08-06T12:23:44Z
updated_at: 2026-08-06T12:35:29Z
---

The pkm-d31f block-ref badge popover is position:fixed at left = badge rect.left, but the badge sits at the right end of the row text. A 260-480px popover anchored there extends past the right viewport edge; fixed elements do not grow the document, so there is no scrollbar and the content is clipped/unreachable (seen on 'List of Large Scale IT Failure'). Same unclamped risk vertically (max-height 60vh from a badge low in the window).

Root cause: BlockRefBacklinksPopover applies x/y verbatim; nothing clamps the fixed coordinates to the viewport. The CSS max-width min(480px, 100vw-24px) caps width but never repositions.

Fix: measure the rendered popover (useLayoutEffect) and clamp left/top into the viewport with a margin, re-clamping when the fetched groups change the popover size.

- [x] Failing unit test: popover opened near the right edge gets clamped left/top
- [x] Clamp implementation (pure clamp helper + layout-effect measurement)
- [x] Web verify (typecheck, unit coverage, e2e)
- [x] Check architecture docs for impact

## Summary of Changes

- `web/src/popoverPosition.ts` (new, Functional Core): `clampPopoverPosition` clamps an anchor point so the measured popover rect stays inside the viewport with a 12px margin; when the popover is larger than the viewport the top-left margin wins, keeping the scrollable start reachable. Contract pinned in `popoverPosition.test.ts`.
- `web/src/components/BlockRefBacklinksPopover.tsx`: a `useLayoutEffect` measures the rendered popover and applies the clamp, re-running when the content swaps (loading -> groups/error) since that changes the measured size. Component tests mock `getBoundingClientRect` (jsdom rects are zero-sized) and assert clamped and pass-through positions.
- `web/e2e/block-ref-indicator.spec.ts`: the badge in this spec sits at the right edge of a full-width row, so the spec now also asserts the popover's bounding box stays inside the viewport — this assertion fails on the unfixed code. The backlink-item click moved from the default center to the item's top-left corner: the old center-click only "worked" because the popover hung off-screen; once visible, the center lands on the inline `((ref))` span, which is its own link back to the target (pre-existing, deliberate rendering).
- `docs/architecture/frontend.md`: one-sentence clamp invariant in the badge/popover paragraph plus a symptom row.

Observation, not changed here: clicking the inline `((ref))` inside a popover backlink item navigates to the *target* block (usually the page you are already on) rather than the referencing source. Pre-existing behavior from pkm-d31f; flag if it should differ.
