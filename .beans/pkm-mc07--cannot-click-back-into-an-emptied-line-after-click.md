---
# pkm-mc07
title: Cannot click back into an emptied line after clicking away
status: completed
type: bug
priority: normal
created_at: 2026-07-10T12:50:50Z
updated_at: 2026-07-10T13:19:36Z
---

A line that has never been written to behaves correctly (shows the 'click to start writing' placeholder and is clickable). But if a line has content that is then deleted, clicking off that now-empty line leaves it in a state where you can't click back into it. Suspected: the empty-but-previously-written line doesn't get restored to the same clickable/placeholder state as a never-written line. (Note: user's report said 'means you can click back in' — assumed typo for 'can't'; verify exact repro when picking this up.)

## Summary of Changes

**Actual repro differs from the bean's framing.** There is no data-model or
JS-level distinction between "never written to" and "written then emptied" —
both are represented identically as `BlockNode.text === ""`, and the click
handler (`onFocusBlock`) is wired the same way regardless of history
(`web/src/components/EditableBlockTree.tsx`). The bean's premise that a
never-written line reliably works is only true because a brand-new block is
created *already focused* (a full-width `<textarea>`), so a user normally
types into it before ever clicking away from it empty. If you *do* blur a
genuinely never-written empty block, it has exactly the same bug.

**Root cause:** in `web/src/styles.css`, the unfocused rendering of a block
(`Tag.block-text`) is a flex item inside `.block-row` (`display: flex`) with
no `flex`/`width` rule, so it shrink-wraps to its content. The focused
counterpart (`.block-input` / `.block-input-wrap`) explicitly gets
`flex: 1; width: 100%`. For a block with real text this is masked (the
rendered glyphs are wide enough to click), but an empty block has zero
content, so `.block-text` collapses to a near-zero-width sliver right after
the bullet — while `.block-row:hover` still highlights the full row,
creating a hover-affordance-vs-click-target mismatch. Confirmed empirically
with a throwaway Playwright script: clicking the center of an emptied,
blurred row's bounding box did not focus the textarea before the fix, and
did after.

**Fix:** `web/src/styles.css` — added `flex: 1` to `.block-text` so it spans
the same row width as `.block-input`/`.block-input-wrap`, matching the hover
highlight and restoring a full-width click target for empty (and all other)
unfocused lines.

**Tests:**
- `web/e2e/edit.spec.ts` — new Playwright e2e test
  `"can click back into a line after emptying it (pkm-mc07)"`. This is a
  real-browser layout/hit-testing bug, invisible to jsdom (Vitest's
  `fireEvent.click` dispatches directly on a node without hit-testing, so it
  can't detect a collapsed click target). Verified red (fails without the
  CSS fix, `toBeFocused()` times out) and green (passes with it) by
  toggling the fix locally before finalizing.
- `web/src/components/EditableBlockTree.test.tsx` — new unit test asserting
  the render/click-handler contract for an emptied block (querying
  `.block-text` structurally since there's no text to query by), as a
  Vitest-level regression guard for the JS wiring, complementing the e2e
  layout coverage.

**Verification:** `pnpm test -- --run` — 273 tests passed (38 files).
`pnpm typecheck` — clean. `npx playwright test e2e/edit.spec.ts` — 3
passed.
