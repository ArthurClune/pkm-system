---
# pkm-youp
title: Textarea auto-resize forces 3 layouts per keystroke
status: todo
type: task
priority: normal
created_at: 2026-09-01T21:28:06Z
updated_at: 2026-09-01T21:28:06Z
parent: pkm-fgjg
---

Tier 2 — the dominant main-thread cost while typing (measured: 6.6 ms/keystroke, 3 forced layouts + 2 style recalcs per character; scripting < 1/7 of task time; 20% of a core at human typing speed on a 300-block page).

## Where
`web/src/outline/useBlockDraft.ts:88-93` — effect on `[draft]` sets `el.style.height = "auto"` then reads `el.scrollHeight` then writes height again: a write→read→write that forces synchronous layout on every character, against a layout root that is the whole page.

## Ideas
- `field-sizing: content` on the textarea where supported (Chromium; check Safari/iPad status at implementation time), keeping the measure-and-set as fallback.
- Otherwise: skip the `auto` reset when the text has only grown on one line (cheap heuristic), or compare against the last applied height and write only on change; read `scrollHeight` once, not between two writes.
- Constrain layout scope: `contain: layout` / `content-visibility` on sibling day sections so the forced layout is cheaper even when it happens.

## Verify
`perf.mjs` scenario F: layouts/keystroke from 3 → ≤ 1; task ms/keystroke down. Editor keyboard behaviour unchanged (see `web/e2e/edit.spec.ts`); check on iPad — the focused block = raw textarea ruling stands.

## Checklist
- [x] Measure baseline with perf.mjs F
- [x] Implement + unit test the height logic
- [x] Re-measure with perf.mjs F (layouts/keystroke 3 -> 1, styles/keystroke 2 -> ~0)
- [ ] iPad sanity check (pending -- for Arthur; cannot be done from this session)
