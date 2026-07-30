---
# pkm-xqir
title: Dark secondary button boundary falls below WCAG 1.4.11 contrast
status: scrapped
type: bug
priority: normal
created_at: 2026-07-30T07:57:22Z
updated_at: 2026-07-30T13:56:46Z
---

Flagged by the pkm-0wg9 whole-branch review as a measured, deliberate aesthetic trade-off worth revisiting — not a regression pkm-0wg9 created, but one it deepened.

pkm-0wg9 lightened `.btn-secondary`'s border from `--color-border-input` to `--color-border`:
- light: `#c8d5dc` -> `#dbe4e8`
- dark: `#3a4552` -> `#2f3944`

In dark, the button's boundary against a `.main-pane`/panel surface (`#20262c`) drops from 1.56:1 to **1.30:1**, and its own fill (`#1c2126`) is only 1.06:1 against that surface. So a dark secondary button is identified almost entirely by its label. WCAG 1.4.11 (non-text contrast) wants 3:1 for component boundaries.

The lighter border is what makes a toolbar stop reading as a row of equal boxes in light mode, so a blanket revert would undo the point of pkm-0wg9. A dark-only `border-color: var(--color-border-input)` override in the two dark theme blocks would keep the light improvement and restore the dark boundary — worth trying first.

- [ ] Decide the approach (dark-only override vs a new dedicated border token)
- [ ] Measure the resulting contrast ratio against panel and page surfaces
- [ ] Check the same surfaces for `.btn-danger` and `.input-control`
- [ ] Guard the chosen values in `web/src/styles.test.ts`
- [ ] Verify live in dark mode


## Decision 2026-07-30: scrapped as an accepted aesthetic trade-off

Measured before deciding, and the bean's own premise did not survive the measurement. The suggested dark-only `border-color: var(--color-border-input)` override does **not** reach WCAG 1.4.11 either — and light mode has never met 3:1 for control boundaries, so pkm-0wg9 deepened a pre-existing deviation rather than creating a new class of problem.

Dark `.btn-secondary` border vs surrounding surfaces:

| border | page `#14181c` | sidebar `#171b1f` | panel `#20262c` |
| --- | --- | --- | --- |
| `--color-border` `#2f3944` (current) | 1.52 | 1.48 | **1.30** |
| `--color-border-input` `#3a4552` (proposed revert) | 1.83 | 1.77 | **1.57** |
| needed for 3:1 vs panel | — | — | **~`#6e7a88`** (3.49) |

Dark `.btn-secondary` fill `#1c2126` vs panel `#20262c`: **1.06**.

Light mode, for comparison: `--color-border` `#dbe4e8` vs `#ffffff` = **1.29**; `--color-border-input` `#c8d5dc` vs `#ffffff` = **1.50**. Genuine compliance in light needs roughly `#959ea4` (3.02).

So the only real fix is a dedicated control-border token at about `#6e7a88` dark / `#959ea4` light applied to `.btn-secondary`, `.btn-danger` and `.input-control` — every control in the app gains a distinctly visible grey outline in both themes, which is precisely the soft look pkm-0wg9 set out to achieve. User decision: keep the current aesthetic, scrap the bean.

A future review re-raising this should start from the numbers above rather than re-deriving them. pkm-cq32 (themed focus ring on the ghost icon buttons) is unaffected and still ships — the focus ring is `--color-link` at 2px, which is a separate, passing affordance.
