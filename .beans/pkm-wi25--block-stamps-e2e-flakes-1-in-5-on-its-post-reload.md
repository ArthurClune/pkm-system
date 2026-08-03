---
# pkm-wi25
title: block-stamps e2e flakes ~1 in 5 on its post-reload stamp assertion
status: todo
type: bug
priority: normal
created_at: 2026-08-03T20:31:54Z
updated_at: 2026-08-03T20:31:54Z
---

`web/e2e/block-stamps.spec.ts:31` ("the page menu toggles a stamp column that
survives a reload") fails roughly one run in five, always at the same place --
line 53, `expect(page.locator(".block-stamp").first()).toBeVisible()`, the
assertion just after `page.reload()`. Error is "element(s) not found" after the
5s timeout. Everything before the reload passes, so the toggle itself and the
first stamp render are fine.

Found while shipping pkm-xrfq (page-menu label flip). Confirmed **pre-existing**
and unrelated to that change: stashed the branch, rebuilt, ran the spec 5x
against unmodified code -> 1 failure; ran it 5x with the change -> 0 failures.
It also passed in two full `pnpm verify` runs, so the whole-suite run is not
where it shows up -- it surfaces when the spec runs alone.

## Leading hypothesis (untested)

The block is created by typing into the textarea, and the reload may land before
that text has been persisted to the replica/server. If the row is gone after the
reload there is no cell to stamp, which matches "element(s) not found" rather
than "found but empty" -- worth distinguishing, since `EditableBlockTree` keeps
an empty `.block-stamp` cell for a block with no timestamps at all
(`EditableBlockTree.test.tsx:765`), so a *present* row would still yield a
locator hit. Alternative: the stamps preference (localStorage) is read before
hydration and the column mounts a beat late, though 5s makes that unlikely.

## Checklist

- [ ] Reproduce in a loop (`for i in $(seq 10)`) and capture the post-reload DOM
      on failure -- specifically whether `.block-row` exists at all
- [ ] If it is the unflushed block: await a server-side confirmation of the text
      before reloading (not a bare timeout), the way other specs wait
- [ ] If it is pref/hydration timing: fix the wait, not the timeout
- [ ] Decide whether this is only a test-harness race or a real user-visible
      "type then immediately reload loses the block" bug -- the latter is much
      more interesting than the flake
