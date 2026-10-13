---
# pkm-il3t
title: 'iPhone keyboard accessory bar: indent, outdent, brackets'
status: in-progress
type: feature
priority: normal
created_at: 2026-10-13T07:22:21Z
updated_at: 2026-10-13T07:48:49Z
---

On iPhone only (not iPad, not a narrow desktop window), while editing a block, show a small bar above the on-screen keyboard with buttons → (Tab/indent), ← (Shift-Tab/outdent), (, ), [, ]. Each button does exactly what the key does on a desktop keyboard: indent/outdent the block, brackets go through the same auto-pair path.

- [x] Phone detection (iPhone, not iPad / narrow window)
- [x] Bar positioned above the keyboard (visualViewport)
- [x] Buttons route through the same keyboard policy as real keys; textarea keeps focus
- [x] Unit tests
- [x] Verify on iPhone simulator (touch taps on every key; soft-keyboard placement not reproducible there)
- [x] Fix: Safari focus-zoom (15px textarea) panned the page and pushed the bar off screen; iPhone viewport gets maximum-scale=1
- [ ] Arthur confirms placement over the real keyboard on his iPhone (open question: in Safari the bar sits above the floating address pill, which iOS 26 seems to exclude from the visual viewport)
- [x] Docs (frontend.md / styling.md)

## Summary of Changes

- `outline/keyboardBar.ts` (Core): the six keys, `isPhoneUserAgent` (iPhone/iPod only), `insertTypedChar`, `keyboardInset`.
- `components/KeyboardBar.tsx` (Shell): portalled strip, `bottom` tracked from `visualViewport`; acts on `pointerdown` (cancelled, so focus stays) because iOS WebKit sends no click after a cancelled pointerdown; `detail === 0` clicks (VoiceOver) also act.
- `BlockInput` splits its keydown into `decideKey` + `runDecision`, so a bar press goes through `decideEditorKey` exactly like the real key; a `none` answer for a character types it.
- CSS: `.keyboard-bar` with `user-select: none`, `-webkit-touch-callout: none`, `touch-action: manipulation` (found on the simulator: touches selected the key labels).
- Docs: keyboard.md iPhone section; frontend-editor.md mechanism note (and corrected "phones get Composer instead of outline editing"); frontend.md module map; styling.md invariant.

Simulator (iPhone 17, real touch actions): →/← indent/outdent, `[[`, `]` step-over, `()` all correct, one press per tap, focus kept, no JS errors. The simulator shows no soft keyboard, so the bar's placement on top of a real keyboard is unverified.
