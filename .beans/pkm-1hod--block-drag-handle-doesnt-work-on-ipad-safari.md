---
# pkm-1hod
title: Block drag handle doesn't work on iPad Safari
status: completed
type: bug
priority: normal
created_at: 2026-07-11T08:41:27Z
updated_at: 2026-07-11T08:46:23Z
---

On iPadOS Safari (even with Magic Keyboard trackpad) pressing/dragging a block bullet never starts an HTML5 drag, so the drop indicator ("drag target") never appears and blocks can't be reordered. Works on macOS Safari.

Root cause: iPadOS routes presses through the touch gesture system. The .bullet drag handle lacks touch-action: none, user-select: none and -webkit-touch-callout: none, so the press is claimed by scroll panning / text selection / the long-press callout before dragstart can fire. The 13x13px hit target compounds it.

Fix: gesture-isolation CSS on the draggable bullet plus an enlarged invisible hit area (pseudo-element) that doesn't change layout or steal the chevron's clicks.

- [x] CSS: touch-action/user-select/touch-callout on .bullet[draggable="true"]
- [x] CSS: enlarged hit area via ::before, dot visuals unchanged
- [x] Web tests + typecheck pass (357 tests)
- [x] Desktop drag still works (verify e2e: drag reorder, hit-area drag, chevron unaffected)

## Summary of Changes

CSS-only fix in web/src/styles.css: the draggable bullet now sets touch-action: none, -webkit-touch-callout: none and (-webkit-)user-select: none so the iPadOS Safari gesture system (scroll pan / text selection / long-press callout) cannot claim the press before dragstart fires — this applies to trackpad pointer presses too, which iPadOS routes through the same touch model. Also added an invisible ::before hit area (~20x23px vs 13x13px, biased away from the chevron) so the handle is grabbable by touch. Verified e2e in a scratch server: drag reorder works, enlarged hit area hit-tests to the bullet, chevron click/collapse unaffected, bullet visuals unchanged. Not verified on physical iPad hardware.
