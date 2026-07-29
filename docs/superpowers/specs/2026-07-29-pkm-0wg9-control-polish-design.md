# Control styling polish (pkm-0wg9)

Date: 2026-07-29
Bean: pkm-0wg9
Follows: pkm-mrru (which completed the button token, added `.input-control`, and
declared `color-scheme`)

## Problem

The app's controls read as blocky. Four causes, all token-level:

1. `--radius-control` is 4px on controls that are ~30px tall — proportionally
   sharp.
2. Every control carries a full-strength 1px `--color-border-input` box, so a
   toolbar becomes a row of equally-weighted rectangles.
3. Fills are flat with no hover or press feedback — no transition anywhere on a
   button.
4. Buttons have no `:focus-visible` rule, so Chrome paints its default blue
   ring, which clashes with the palette. Now more visible since pkm-mrru
   declared `color-scheme`.

Three candidate directions were built into the real app and compared as 2x
screenshots of `/files`. The chosen direction is "pill actions, soft fields":
buttons become pills, fields lose their outline in favour of a soft fill.

Pills are not a new idiom here — `.filter-chip`, `a.tag` and
`.top-bar-search-input` already use `border-radius: 999px` literally. This work
names that idiom as a token and applies it consistently.

Scope: app-wide. These are token edits, so the sidebar, assistant panel, confirm
dialogs, PDF viewer, top bar and `/files` all move together.

## Design

### Radius tokens

Split the overloaded `--radius-control` into three named tokens:

```css
--radius-pill: 999px;   /* actions: buttons, ghost icon buttons, search boxes */
--radius-field: 7px;    /* text inputs, selects, textareas */
--radius-control: 4px;  /* unchanged */
```

`--radius-control` keeps its 4px value on purpose. Its other consumers are
`.inline-code`, `.block-row` highlights, `.block-ref:hover`, `.math-error`,
`.file-thumb` and `.file-badge` — none of which should round up with the
controls. `styles.test.ts` already asserts `--radius-control: 4px`, and that
assertion stays true.

Geometry does not change with theme, so the new tokens are declared once in the
base `:root` and not repeated in the dark blocks — matching how the existing
radius scale is declared.

### Actions

`.btn-secondary` and `.btn-danger`:

- `border-radius: var(--radius-pill)`
- `padding: 5px 14px` (from `4px 12px`) — pills need more horizontal room
- `transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease`
- `:focus-visible { outline: 2px solid var(--color-link); outline-offset: 1px }`

`.btn-secondary` keeps its border so it still reads as pressable, but one step
lighter: `--color-border-input` → `--color-border`. Its hover then deepens that
border to `--color-border-strong`, in addition to the existing background
change. `.btn-danger` keeps its solid `--color-error` fill and border.

Existing per-call-site padding overrides are intentional and stay. Consequences
worth stating:

- `.nav-sidebar-entry-controls button` is 20x20 with `padding: 0` — it becomes a
  circle. This is desirable for the up/down/remove icon buttons.
- `.confirm-dialog-actions button` keeps `6px 14px`; `.filter-toggle` keeps
  `1px 10px`; `.upload-error button` keeps `1px 8px`;
  `.nav-sidebar-add button[type="submit"]` keeps `3px 10px`.
- Two need slightly more horizontal room to work as pills:
  `.reference-link-button` (`1px 8px` → `1px 10px`) and `.composer-send`
  (`6px 12px` → `6px 14px`).

### Fields

`.input-control` plus the three bespoke field rules — `.nav-sidebar-add input`,
`.assistant-input textarea`, `.composer-input` — share one treatment:

- `border-radius: var(--radius-field)`
- `background: var(--color-bg-subtle)`
- `border: 1px solid transparent`
- on `:focus` — `background: var(--color-bg-surface)` and
  `border-color: var(--color-border-input)`
- `transition: background 0.12s ease, border-color 0.12s ease`

`.input-control:focus-visible` already carries the themed ring from pkm-mrru; the
bespoke field rules join it in that selector list rather than restating it.

The border is transparent rather than absent so focus does not shift layout —
the same trick the top bar's ghost buttons already use.

`.files-search` additionally takes `--radius-pill`, matching the top bar's
search pill.

**Excluded: `.block-input`.** The outline editor is a writing surface, not a
form field; a chip background would be wrong there. It keeps its current
transparent, borderless styling.

### Ghost buttons

`.top-bar-menu-button, .sidebar-toggle-button, .help-button` take
`--radius-pill` so their hover chip is round rather than a small square. They
keep everything else, including their transparent-border hover trick.

## Non-goals

- No change to `.block-input` or any outline/editor surface.
- No change to `--radius-card` / `--radius-panel`, or to cards, menus, popovers
  and dropdowns.
- No change to `.filter-chip` / `a.tag` — they are already pills.
- No new colour tokens. Hover and focus reuse the existing border and link
  tokens.
- The per-card selection checkbox in `/files` stays a native control (explicitly
  out of scope per the user).

## Verification

Drift-guard assertions in `web/src/styles.test.ts`:

- the three radius tokens exist with their stated values;
- `.btn-secondary` / `.btn-danger` use `--radius-pill` and have a
  `:focus-visible` ring;
- `.input-control` uses `--radius-field`, a transparent border, and lifts to
  `--color-bg-surface` on focus;
- the bespoke field rules share the field treatment rather than restating their
  own;
- `.block-input` does **not** gain a background or border (guards the exclusion).

Visual verification against a scratch server (per `.claude/skills/verify`), in
both light and dark:

- `/files` — filter row, toolbar, selection state, confirm dialog;
- sidebar edit mode — the 20x20 icon buttons as circles, the Add field;
- assistant panel — New chat, Send, the model select, the textarea;
- an outline page with backlinks — `.show-more`, `.filter-toggle`,
  `.reference-link-button`;
- the top bar — ghost buttons and the search pill.

Then `cd web && pnpm verify` (typecheck, unit coverage, lint, FCIS, budgets,
Playwright E2E).

## Risks

- **Fields lose their outline while buttons keep theirs**, which slightly
  inverts the usual convention. This is what makes the direction read as
  modern; it was reviewed in a real screenshot and approved. Dark mode gets an
  explicit check because `--color-bg-subtle` sits *darker* than
  `--color-bg-surface` there, so a field reads as a well rather than a raised
  chip.
- **`padding: 5px 14px` widens every default-padded button.** The `/files`
  toolbar has six in a row; confirm it still fits at a phone width without
  wrapping badly.
- **Pill radius on short wide buttons is fine; on tall multi-line buttons it
  would look like a lozenge.** No such button exists today; if one appears it
  should opt out rather than the token changing.
