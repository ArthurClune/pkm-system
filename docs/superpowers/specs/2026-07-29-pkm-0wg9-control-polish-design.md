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
   ring, which clashes with the palette. More visible since pkm-mrru declared
   `color-scheme`.

Three directions were built into the real app and compared as 2x screenshots.
The chosen direction is **pill actions, and one field family modelled on the
existing Cmd-U search**.

Pills are not a new idiom here — `.filter-chip`, `a.tag` and
`.top-bar-search-input` already use `border-radius: 999px` literally. This work
names that idiom as a token and applies it consistently.

Scope: app-wide. These are token edits, so the sidebar, assistant panel, confirm
dialogs, PDF viewer, top bar and `/files` all move together.

## Design

### Radius tokens

Split the overloaded `--radius-control` into three named tokens:

```css
--radius-pill: 999px;   /* actions: buttons, ghost icon buttons, search fields */
--radius-field: 7px;    /* text inputs, selects, textareas */
--radius-control: 4px;  /* unchanged */
```

`--radius-control` keeps its 4px value on purpose. Its other consumers are
`.inline-code`, `.block-row` highlights, `.block-ref:hover`, `.math-error`,
`.file-thumb` and `.file-badge` — none of which should round up with the
controls. `styles.test.ts` already asserts `--radius-control: 4px`, and that
assertion stays true.

Geometry does not change with theme, so the new tokens are declared once in the
base `:root`, matching how the existing radius scale is declared.

### Actions

`.btn-secondary` and `.btn-danger`:

- `border-radius: var(--radius-pill)`
- `padding: 5px 14px` (from `4px 12px`) — pills need more horizontal room
- `transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease`
- `:focus-visible { outline: 2px solid var(--color-link); outline-offset: 1px }`

`.btn-secondary` keeps its border so it still reads as pressable, but one step
lighter: `--color-border-input` → `--color-border`. Its hover then deepens that
border to `--color-border-strong`, in addition to the existing background
change.

Existing per-call-site padding overrides are intentional and stay. Consequences
worth stating:

- `.nav-sidebar-entry-controls button` is 20x20 with `padding: 0` — it becomes a
  circle. Desirable for the up/down/remove icon buttons.
- `.confirm-dialog-actions button` keeps `6px 14px`; `.filter-toggle` keeps
  `1px 10px`; `.upload-error button` keeps `1px 8px`;
  `.nav-sidebar-add button[type="submit"]` keeps `3px 10px`.
- Two need slightly more horizontal room as pills: `.reference-link-button`
  (`1px 8px` → `1px 10px`) and `.composer-send` (`6px 12px` → `6px 14px`).

**Stretch guard.** `.assistant-input` is a flex row with the default
`align-items: stretch`, so its Send button currently stretches to the textarea's
full height. As a pill that becomes a tall lozenge. Send takes
`align-self: flex-end`. `.composer-send` gets the same check.

### The danger fill

`--color-error` is `#ff6b6b` in dark — tuned for error *text* on a dark
background. As a solid button fill behind white text it reads as bright coral,
and the pill shape amplifies it. Add a fill-only token:

```css
--color-error-fill: #c23030;  /* light: unchanged from today */
--color-error-fill: #a83a3a;  /* dark: deep red, not coral */
```

`.btn-danger` uses `--color-error-fill` for its background and border.
`--color-error` keeps its current job: error text, `.file-badge.status-failed`,
`.assistant-error`.

### Fields: one family, modelled on the Cmd-U search

The top bar's search is the reference look. Every field matches it:

- `background: var(--color-bg-subtle)`
- `border: 1px solid var(--color-border-strong)`
- on `:focus` — `background: var(--color-bg-surface)` and
  `border-color: var(--color-border-input)`
- `transition: background 0.12s ease, border-color 0.12s ease`
- `border-radius: var(--radius-field)`

This covers `.input-control` plus the three bespoke field rules, which stop
restating their own colours and join the shared selector:
`.nav-sidebar-add input`, `.assistant-input textarea`, `.composer-input`.

`.input-control:focus-visible` already carries the themed ring from pkm-mrru; the
bespoke fields join it in that selector list.

The border is `--color-border-strong` rather than absent because that is what
the Cmd-U search uses. In light mode `--color-border-strong` and
`--color-border-input` are the same value, so focus shows as a fill lift plus
the focus ring; in dark they differ by one step.

**Excluded: `.block-input`.** The outline editor is a writing surface, not a
form field; a chip background would be wrong. It keeps its current transparent,
borderless styling. This is asserted by a test.

### Search fields become one shared thing

Today the top bar's search look lives entirely in `.top-bar-search*` rules, and
`/files` has a plain unadorned input. They must be identical. Extract the
reusable part:

- `.search-field` — the relative wrapper (was `.top-bar-search`)
- `.search-field-icon` — the absolutely-positioned magnifier (was
  `.top-bar-search-icon`)
- `.search-field-input` — the pill input: `--radius-pill`, the field colours
  above, `padding-left` clearing the icon, `font-size: 14px`

`.top-bar-search-input` keeps only what is top-bar-specific: its `width: 220px`,
the `width: 320px` focus growth, and the `transition: width 0.15s`.
`SearchBar.tsx` composes both classes.

`Files.tsx` wraps its search input in the same markup and reuses `SearchIcon`
from `components/icons.tsx`, which is already a shared export.

**Do not reorder that markup.** `.top-bar-search-hint` is hidden by
`.top-bar-search-input:focus + .top-bar-search-hint` (pkm-absu), so the `kbd`
must stay the input's immediate next sibling. `styles.test.ts` asserts that
selector. The refactor adds classes only.

### Ghost buttons

`.top-bar-menu-button, .sidebar-toggle-button, .help-button` take
`--radius-pill` so their hover chip is round rather than a small square. They
keep everything else, including their transparent-border hover trick.

### The assistant's model select

`AssistantPanel.tsx` renders a bare `<select>` for the model, so it keeps the
old bordered box while everything around it changes. It gets `.input-control`.

## Non-goals

- No change to `.block-input` or any outline/editor surface.
- No change to `--radius-card` / `--radius-panel`, or to cards, menus, popovers
  and dropdowns.
- No change to `.filter-chip` / `a.tag` — already pills.
- No change to the top bar's search behaviour: the width animation, the ⌘U hint
  chip and the results dropdown all stay exactly as they are.
- The per-card selection checkbox in `/files` stays a native control (explicitly
  out of scope per the user).

## Verification

Drift-guard assertions in `web/src/styles.test.ts`:

- the three radius tokens exist with their stated values;
- `.btn-secondary` / `.btn-danger` use `--radius-pill` and have a
  `:focus-visible` ring;
- `.btn-danger` fills with `--color-error-fill`, and that token differs between
  the light and dark blocks;
- the shared field selector sets the subtle fill, the strong border and the
  focus lift, and the bespoke field rules no longer restate their own
  background/border;
- `.search-field-input` uses `--radius-pill`;
- `.top-bar-search-input` still only carries its width behaviour, and the hint's
  sibling selector still exists;
- `.block-input` does **not** gain a background or border (guards the exclusion).

Component tests: `Files.test.tsx` asserts the search input is inside
`.search-field` and still reachable by its `Search files` label;
`AssistantPanel` asserts the model select carries `.input-control`;
`TopBar.test.tsx` / `SearchBar` tests must keep passing unchanged.

Visual verification against a scratch server (per `.claude/skills/verify`), in
both light and dark:

- `/files` — filter row with both searches visible for comparison, toolbar,
  selection state, confirm dialog;
- sidebar edit mode — the 20x20 icon buttons as circles, the Add field;
- assistant panel — New chat, Send (not a lozenge), the model select, the
  textarea;
- an outline page with backlinks — `.show-more`, `.filter-toggle`,
  `.reference-link-button`;
- the top bar — ghost buttons, the search pill unchanged, the ⌘U hint still
  hiding on focus.

Then `cd web && pnpm verify` (typecheck, unit coverage, lint, FCIS, budgets,
Playwright E2E).

## Risks

- **The search-field extraction touches the top bar**, which has behaviour the
  tests pin (hint chip sibling selector, focus width growth). The extraction is
  class-only; if any top-bar test needs changing, that is a signal the refactor
  went too far.
- **`padding: 5px 14px` widens every default-padded button.** The `/files`
  toolbar has six in a row; confirm it still wraps sanely at a phone width.
- **Pill radius on short wide buttons is fine; on tall ones it becomes a
  lozenge.** The assistant's Send is the one live case and is handled; any
  future tall button should opt out rather than change the token.
