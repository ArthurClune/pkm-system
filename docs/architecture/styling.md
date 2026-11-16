# Styling and theming (web/)

All styling is plain CSS in a single file, `web/src/styles.css`, with no
framework or CSS-in-JS. The app around it is in [frontend.md](frontend.md).

`styles.css` is divided by `/* == Name == */` markers. Sections run by area:
tokens and base elements, layout and chrome, outline and editing, inline
content and media, references and search, then pages and feature surfaces. A
new rule goes in the section for the component it styles, and a new section
goes in its area, not at the end of the file.

Later rules win at equal specificity, and a media query adds none. **The shared
`Responsive` section is the last in the file**, so its breakpoint overrides
beat every base rule. A section with its own `@media` block keeps it right
after the rules it overrides. Moving a rule earlier or later can change which
rule wins, so a reorder checks each moved rule against equal-specificity rules
that set the same property on the same element. `styles.test.ts` pins unique
section names, Tokens and themes first and Responsive last. The verify skill
selects by class, so
before removing one, grep the "Known selectors" table in
`.claude/skills/verify/SKILL.md` too.

## Tokens and theming

Design tokens are custom properties on `:root`: a color system
(`--color-bg/-surface/-text*/-accent/-link/-tag/-find-*/…`), a radius scale,
`--hljs-*` code tokens, and the code font (`--font-mono`, `--font-size-code`).

Theming is three-way: light by default, OS dark via
`@media (prefers-color-scheme: dark)`, and an explicit `data-theme` override
that `useTheme.ts` stamps on `<html>` (system → light → dark, persisted to
localStorage). `color-scheme` is declared per theme; without it Chrome paints
`select` and date widgets light whatever the CSS says.

A `[[Tree/Page]]` ref can take a per-tree colour. `PageLink` stamps the
lowercased prefix before the title's first `/` as `data-ns`, and `styles.css`
maps prefixes onto `--color-link-*` group tokens. Adding a tree
is a stylesheet-only change, since `pageNamespace` does not know which trees
are coloured. Tags and attribute names never take a tree colour.

Radius steps are assigned by role:

| Token | Used for |
|---|---|
| `--radius-pill` | buttons, ghost icon buttons, search fields |
| `--radius-field` | text inputs, selects, textareas |
| `--radius-control` | inline code, block rows, badges, thumbs |
| `--radius-card` | embedded content |
| `--radius-panel` | floating menus, dropdowns, the main pane |

## Block row layout

| Element | Rule |
|---|---|
| `.block-stamp` | the row's last flex child, beside the textarea, so focus cannot shift it. Its band tokens (`--color-stamp-week`, `-month`, `-year`) are solid, so a band survives hover and focus; `stampBand`'s `"older"` rows have none. Hidden under 600px |
| `.block-row:hover` | fills with `--color-row-hover`, never `--color-bg-subtle`. Table headers, fields and panels inside a row fill with the subtle token, so a hovered row in that colour hides them |
| `.block-ref-badge` | must not join `.block-stamp`'s under-600px `display: none`: on touch it is the only route to the references popover |
| `.block-input` | borderless and transparent; its `field-sizing` auto-grow rule is in [frontend-editor.md § The editor](frontend-editor.md#the-editor) |
| `.block-input.code-input` | set while the draft is one code fence (mermaid excepted) or one display-math block, as `editsAsCode` in `grammar/tokenize.ts` decides. It takes `.code-block`'s font tokens, so a typed column is the column that renders |

The stamp flag reaches the tree as a prop from `PageView`. `EditableBlockTree`
never reads `BlockStampsContext`, or the journal and sidebar panels would grow
the column too. `.block-ref-popover` copies `.block-menu`'s surface, a pair
`styles.test.ts` pins.

## Controls

Buttons and fields are styled by named class, and there is no bare
`input`/`select` element rule: a new control opts in by name.

- **Buttons** are pills. `.btn-secondary` carries its own padding. A small
  button beside text adds `.btn-compact`, which sits after `.btn-secondary`
  because it overrides it at equal specificity. `.btn-danger` fills with
  `--color-error-fill`, a token separate from the error text colour. The
  chrome buttons (`.top-bar-menu-button`, `.sidebar-toggle-button`,
  `.help-button`) have a transparent border, so hover does not shift layout.
- **Fields** are `.input-control` and `.search-field` /
  `.search-field-input`, so `/files`' search is the same field as `Cmd-U`. The
  resting fill is `--color-bg-subtle`, lifting to `--color-bg-surface` on
  focus; call sites add geometry only. `.nav-sidebar-add input` sits on
  `.left-nav`'s own `--color-bg-subtle`, so it takes the surface fill at rest.
- **Tables.** `DataTable` (`web/src/tables/`) renders `.data-table` inside
  `.data-table-scroll`, with `.roam-table`'s cell look, so a plain table
  does not change when its chunk loads. Body cells of both, and `.query-card`,
  are opaque on `--color-bg-surface`, so a hovered or focused row tints
  around a table or card, not inside it. Both tables are at least
  `max-content` wide so a narrow screen scrolls them, so each body cell's
  content sits in a `.table-cell` that caps its width. Without the cap, one
  long line (a markdown link's URL) widens its column until the rest scroll
  out of view. Its header is a
  `.data-table-sort` button filling the `th`. The open cell is
  `.cell-editor`, a `<textarea>` and never an `<input>`
  ([why](frontend-editor.md#the-cell-editor)).
  Its popup, `.cell-editor-popup`, is portalled and `position: fixed`, since
  the scroll box would clip an absolute one. It holds the outline's
  `.ac-popup` with the frame removed. `.table-toolbar` holds the filter, an
  `.input-control`. A header with a column menu wraps the sort button and
  `.data-table-menu` in `.data-table-head`. A query block adds `.query-views`
  (the view switch, `aria-pressed` on the shown view), `.query-cards` and
  `.query-cell-badge`. `.cell-media-label` is media in a cell: a borderless
  button in `--color-link` that reads as a link, or a muted `span` when it
  has nowhere to go. A jump to a plain-table cell flashes its `<td>` with
  `td.flash-target`, whose keyframes have no `to`, so the cell's opaque fill
  returns instead of the row behind showing through.
- **Anchors among buttons.** The global `a` rule sets `font-weight: 600`, so
  an anchor placed among buttons pins its weight in its own component rule.

In the assistant's tool line only `.assistant-tool-failed` takes
`--color-error`; a declined write and `.assistant-tool-warning` keep the
line's colour.

`.block-menu` and `.top-bar-menu` signal state differently:

| | `.block-menu` | `.top-bar-menu` |
|---|---|---|
| Check slot | `.block-menu-item-check`, reserved on checkable items | none |
| State signal | `aria-checked` on the item | the label flips (`Show timestamps` / `Hide timestamps`) |
| Role | `menuitemradio` for a checkable item, else `menuitem` | `menuitem` |

An item whose state is in its text must not also claim `menuitemcheckbox`, or
a screen reader announces the state twice. `.top-bar-menu` items keep
`white-space: nowrap`: the menu shrink-to-fits inside a button-sized parent,
so a two-word label would wrap past its `min-width`.

## Focus and interactive affordances

Every focusable control uses this ring:

```css
:focus-visible { outline: 2px solid var(--color-link); outline-offset: 1px; }
```

It is declared per component, next to that component's own rule.
`.asset-image-trigger` and `button.file-thumb` take `outline-offset: 2px` to
clear a rounded image corner. The exceptions, each commented in `styles.css`:

- `.top-bar-search-input` sets `outline: none`, because its desktop width
  growth is the affordance; the `@media (max-width: 600px)` block re-enables
  the ring.
- `DatePickerPopup`'s buttons get no ring. The popup is mouse-only, and every
  element `preventDefault`s on mousedown so the textarea keeps focus.
  `styles.test.ts` asserts the absence.
- `.data-table-sort`, `.data-table-menu` and a focused `td.editable` take
  `outline-offset: -2px`. The table's scroll box clips a ring drawn outside
  an edge column, and a cell's ring outside its collapsed border would sit
  under the neighbouring cells.
- `.cell-editor` sets `outline: none`. It exists only while focused, so its
  border is the focus signal.
- `.bullet` uses the standard ring inside a `4px solid transparent` border
  that `.bullet.closed` colours, so any restyle must stay distinguishable from
  `.closed`.

### Focus by surface

- **Nav controls.** `.nav-link` styles both `<a>` destinations and `<button>`
  controls in the left nav (`App.tsx`, `SidebarNav.tsx`, `ThemeToggle.tsx`),
  so reading `styles.css` alone will not find every focusable control.
- **Content anchors.** `a.page-link`, external links and the
  `.page-title > a` heading link keep the UA ring; at the block line-height an
  offset ring collides with the line above.
- **The closed phone drawer** pairs `translateX(-100%)` with
  `visibility: hidden`, restored by `.left-nav.open`, or its links stay tab
  stops. The hamburger carries `aria-expanded` and `aria-controls="left-nav"`.
  Closing returns focus to it, guarded on the drawer's previous state because
  every nav link (`NavRouteLink`, `NavPageLink`, `SidebarNav`) calls
  `onNavigate`, which is `setNavOpen(false)`.
- **Clickable headings.** Page-title rename (`.page-title-edit`) and the
  Unlinked references collapse (`.section-toggle`) wrap their label in a real
  `<button>` inside the heading, with `font: inherit`, explicit
  `letter-spacing` and `text-transform`, and `display: block; width: 100%` so
  the header row stays the hit area. The trigger owns `aria-expanded` and marks
  its chevron `aria-hidden`. `.page-title-edit` never takes a fixed
  `aria-label`: accname walks the `<h1>`'s children, so a name on the button
  renames the page's heading.

## Layout invariants

- **Containment.** Nothing `position: fixed` may render inside a box carrying
  `content-visibility` or `contain: layout`, which becomes the containing block
  for fixed descendants. `BlockMenu` and `Popover` therefore portal to
  `document.body`, and `e2e/popover-placement.spec.ts` asserts each lands at
  its click point. Adding containment anywhere means auditing what renders
  inside it. `.journal-day` carries none.
- **`.pdf-frame`** carries `contain: layout` because a contained box offers no
  baseline. `.block-row` aligns on the baseline, so it takes it from
  `.pdf-footer`'s text rather than a canvas inside the scroller. A numbered
  bullet is text, so `.bullet.numbered` joins with `align-self: baseline`.
  In `.pdf-overlay` the frame scrolls only as a flex item that fills the
  overlay's column. Overlay-only mode (`/files`, table cells) wraps it in
  react-pdf's `.react-pdf__Document` div, so that div is made the filling
  flex column too; otherwise it grows to the whole document and nothing
  scrolls. `e2e/cell-media.spec.ts` wheels the frame to pin it.
- **Embedded image caps.** `.asset-image` (an external `<img>`) and
  `.asset-image-trigger` (an uploaded image's wrapper) share one
  `max-width` cap. The inner image resets to `max-width: 100%` so the caps do
  not multiply. The phone override back to full width must stay after those
  rules, because a media query adds no specificity.
- **Stacking.** Every `z-index` reads one of the `--z-*` tokens declared
  together on `:root` in `styles.css`, bottom to top. `styles.test.ts` ("the
  z-index scale") pins that order, so a new layer takes a token between its
  neighbours.
