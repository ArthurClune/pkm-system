# pkm-4ler — block timestamps in the page margin

Date: 2026-08-03
Bean: pkm-4ler (Expose block created/last-changed timestamps in the UI)

## Goal

When a preference is on, every block on a main-pane page shows its
last-changed date in a right-hand margin column, tinted by age. The point is
peripheral awareness of how stale what you are reading is — not an audit
trail. It must be quiet enough to leave on permanently.

pkm-r7k8 is the prerequisite and has shipped: collapse no longer bumps
`updated_at`, and NULL block `created_at` values were backfilled, so the
signal is now trustworthy.

## What already exists

- `BlockNode` carries `created_at` and `updated_at` (epoch **milliseconds**,
  both nullable) through `/api/page/{title}` into the client tree. No server
  or schema change is needed.
- The page menu is TopBar's `…` button, rendered only on `/page/*` routes.
- `.block-row` is a flex row (chevron, bullet, text) with
  `align-items: baseline`. `.block-text` is `flex: 1`.
- `.block-children` indents from the left only, so every row in a page —
  whatever its depth — already shares the same right edge.
- `EditablePage` is mounted from exactly three places: `PageView` (main
  pane), `Journal` (the daily scroll), `EditableSidebarPanel` (right
  sidebar).
- `transitionOutline` (outline/outlineState.ts, functional core) is the one
  reducer where both `local-ops` and `remote-ops` call `applyOps`.
- `applyOps` (outline/tree.ts) is pure and clockless: it never touches
  `created_at`/`updated_at`, and blocks it creates get `null` for both.
- `replica/localOps.ts` already implements the "which ops bump
  `updated_at`" rule against the replica, including pkm-r7k8's exclusion of
  `set_collapsed`.

## Design

### 1. The toggle

A `role="menuitemcheckbox"` item labelled **"Show timestamps"** in TopBar's
`…` page menu, reusing BlockMenu's existing checkmark idiom: a `✓` inside a
fixed-width span (`.block-menu-item-check` is the precedent) plus
`aria-checked`.

One global preference, not per-page. Persisted to `localStorage`, default
**off**, following the established split: a pure core module for the storage
key, parsing and toggling (as `sidebar.ts` does) plus a thin hook shell (as
`useSidebarCollapsed.ts` does).

The live value rides a small context provider in `App.tsx`. TopBar sets it
and `PageView` reads it; two independent `useStamps()` calls would not
re-render each other on toggle, so they would visibly disagree until a
route change.

The menu exists only on `/page/*`, which is exactly where the setting has
any effect, so no surface is left holding an unreachable preference.

### 2. The margin cell

Rendered inside `EditableBlockTree`'s row, as the last flex child of
`.block-row` — after `.block-text` or, when the block is focused, after
`BlockInput`'s textarea:

```
<span className="block-stamp block-stamp-week" title="3 August 2026, 14:22">
  3 Aug 26
</span>
```

Geometry:

- Fixed width (~56px of text plus padding, `text-align: right`), so the
  stamps form a true column rather than tracking each row's text length.
- `.block-text` is `flex: 1`, so the text column narrows by the cell width
  automatically. No change to `--pane-width` or `.main-pane` padding.
- Because the cell is a sibling of the textarea inside the same row,
  focusing a block cannot shift it — there is no layout jump on focus.
- `.block-row`'s `align-items: baseline` puts the stamp on the row's
  baseline, including on heading rows.

Content:

- The date shown is `updated_at ?? created_at`. `created_at` is a fallback
  for a missing `updated_at`, not a second column.
- Format `3 Aug 26` — compact and precise. The band tint already carries
  "recent versus old", so the text carries what the colour cannot.
- `title` gives the full local date and time for hover precision.
- When both timestamps are null the span still renders, **empty**. An
  omitted span would let that row's text run wider than its neighbours' and
  break the column.

Age bands, from `updated_at ?? created_at` against now:

| band | age | meaning |
|---|---|---|
| `week` | ≤ 7 days | this week |
| `month` | ≤ 31 days | this month |
| `year` | ≤ 365 days | this year |
| `older` | > 365 days | flat, however old |

Tint direction: **warm for fresh, fading to a barely-there cool tint for
old** ("cooling off"). This puts the strongest colour on the rare recent
rows; a page of entirely old material reads as almost untinted. The
alternatives (sepia-yellowing, or a cool ramp that deepens with age) put
their heaviest ink on the commonest rows in a database this age.

Four new tokens — `--color-stamp-week`, `-month`, `-year`, `-older` —
declared in **all three** theme blocks (`:root`, the
`prefers-color-scheme: dark` media query, and `:root[data-theme="dark"]`),
per the existing stylesheet invariant. Solid fills, not alpha, so they stay
predictable over `.block-row:hover` and `.block-row.focused` backgrounds.
Starting values, to be trimmed by eye in the running app:

| token | light | dark |
|---|---|---|
| `--color-stamp-week` | `#f7c9a6` | `#4d3526` |
| `--color-stamp-month` | `#fae3cf` | `#38302a` |
| `--color-stamp-year` | `#e4ebf1` | `#2b333a` |
| `--color-stamp-older` | `#f1f4f7` | `#252b31` |

The dark warms are a notch less saturated than the mockup's, so they read as
tint rather than brown.

Below the 600px breakpoint the column is hidden. A ~68px gutter is too much
of a phone line, and the page-menu toggle is a desktop affordance.

Surfaces: only `PageView` passes the flag down. `Journal` and
`EditableSidebarPanel` mount the same `EditablePage` without it, so the
daily scroll and the right sidebar stay bare. This is structural — no route
sniffing inside the tree. A daily note opened at `/page/<date>` is a main
page and gets stamps like any other.

The flag therefore travels as a **prop**, defaulting to off:
`PageView` reads the context and passes `stamps` to `EditablePage`, which
passes it to `EditableBlockTree`, which passes it down its `EditableBlock`
recursion. `EditableBlockTree` must not read the context itself — that would
hand the journal and sidebar mounts the column too, which is the one thing
this rule exists to prevent.

### 3. Keeping the date honest while you edit

Today the in-memory tree's timestamps are only what the page load returned.
Editing a block would leave its date and tint stale until you navigated away
and back, and a block you just created would show an empty cell.

Fix: both `local-ops` and `remote-ops` events gain an `nowMs` field, supplied
by `outlineSessions`' `applyLocal`/`applyRemote` (imperative shell, holds the
clock). `transitionOutline` then stamps `updated_at = nowMs`, after
`applyOps`, on every uid that both (a) is the target of an op in this batch
for which `opBumpsUpdatedAt` is true, and (b) is present in this page's tree
once the batch has been applied — ops for other pages, and blocks the batch
deleted, are skipped. The functional core stays clockless, and
edits arriving from another device update exactly as local ones do, because
both already flow through this reducer.

Which ops count comes from a new pure predicate `opBumpsUpdatedAt(op)`,
extracted from the rule `replica/localOps.ts` already applies. That keeps
pkm-r7k8's semantics — notably that `set_collapsed` is **not** a change — in
one place, so the replica and the displayed date cannot drift apart.

Blocks created locally are stamped by the same path, so they show today's
date rather than a blank.

### New module

`outline/blockStamps.ts` (Functional Core):

- `stampTs(node): number | null` — `updated_at ?? created_at`
- `stampBand(nowMs, ts): "week" | "month" | "year" | "older"`
- `formatStamp(ts): string` — `"3 Aug 26"`
- `opBumpsUpdatedAt(op): boolean`

All pure, all clock-injected. No DOM needed to test any of it.

## Testing

- **Unit (core):** band edges at exactly 7d / 31d / 365d; the
  `updated_at ?? created_at` fallback and the both-null case; `formatStamp`
  output; `opBumpsUpdatedAt` returning false for `set_collapsed` and true
  for text/heading/view-type/move/create.
- **Unit (reducer):** a `local-ops` batch stamps the touched uids and leaves
  others alone; a `set_collapsed`-only batch stamps nothing; a `remote-ops`
  batch stamps the same way.
- **Component:** `EditableBlockTree` renders the cell with the right band
  class when enabled, renders nothing when disabled, and renders an empty
  cell when both timestamps are null.
- **Styles:** `styles.test.ts` pins the four tokens in all three theme
  blocks and the ≤600px hide rule.
- **TopBar:** the menu item reflects and flips the stored preference, with
  `aria-checked` tracking it.
- **Integration:** with the preference on, `PageView` shows the column while
  the journal scroll and a sidebar panel of the same page do not.
- **E2E:** one Playwright pass — toggle on, a date is visible on a page, and
  it survives a reload.

Full gates before completion: `cd server && uv run pytest -q`, `uv run
pyrefly check`, `uv run ruff check`, `cd web && pnpm verify`.

## Docs to update in the same branch

`docs/architecture/frontend.md`:

- the module map — `outline/blockStamps.ts`, the preference core/hook pair,
  and the new context provider
- the styling sections — the four `--color-stamp-*` tokens and the
  `.block-stamp` control class
- a prose note on why the stamp cell lives *inside* `.block-row` (it is what
  makes the column align across nesting depths and keeps focus from shifting
  it), and on why `set_collapsed` must not stamp

## Out of scope

Deliberately not in this change, though the bean lists them as candidates:
hover tooltips on the bullet, a block-menu "info" entry, recency search or
filtering, and last-changed on search results or backlink entries. The bean's
open question about the ~6% of `created_at` values that are page-level
approximations from pkm-r7k8's backfill is not surfaced in the UI — a date
that is right to the day is enough for a peripheral cue.
