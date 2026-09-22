# Styling and theming (web/)

All styling is plain CSS in a single file, `web/src/styles.css` — no framework,
no CSS-in-JS. The SPA's structure around it is in [frontend.md](frontend.md);
failures and their fixes are indexed by symptom in
[troubleshooting.md](../troubleshooting.md).

## Tokens and theming

Design tokens are custom properties on `:root`: a color system
(`--color-bg/-surface/-text*/-accent/-link/-tag/…`), a five-step radius
scale, and `--hljs-*` code tokens.

Theming is three-way: light by default, OS dark via
`@media (prefers-color-scheme: dark)`, and an explicit `data-theme` override
stamped on `<html>` by `useTheme.ts` (system → light → dark, persisted to
localStorage). `color-scheme` is declared per theme; without it Chrome paints
`select` and date widgets light whatever the CSS says.

Page links are `--color-link`, but a `[[Tree/Page]]` ref can take a per-tree
colour: `PageLink` stamps the lowercased prefix before the title's first `/` as
`data-ns`, and `styles.css` maps a few prefixes onto four group tokens. Tags and
attribute names never take a tree colour. Adding a tree is a stylesheet-only
change; `pageNamespace` does not know which trees are coloured.

| Token | Trees |
|---|---|
| `--color-link-cloud` | aws, azure, gcp |
| `--color-link-ai` | claude, llm, gpt |
| `--color-link-work` | project, uos |
| `--color-link-reading` | paper, book, article |

Radius steps are assigned by role:

| Token | Size | Used for |
|---|---|---|
| `--radius-pill` | 999px | buttons, ghost icon buttons, search fields |
| `--radius-field` | 7px | text inputs, selects, textareas |
| `--radius-control` | 4px | inline code, block rows, badges, thumbs |
| `--radius-card` | 6px | embedded content |
| `--radius-panel` | 8px | floating menus, dropdowns, the main pane |

Block stamps add three band tokens — `--color-stamp-week`, `-month`, `-year`
— declared in all three theme blocks. The fourth band has no token and no
background rule, so `stampBand`'s `"older"` rows render as plain text under
`.block-stamp-older`. The tints are solid fills, not alpha, so a band survives
`.block-row:hover` and `.block-row.focused`. Below the 600px breakpoint the
`.block-stamp` column is `display: none`.

The stamp cell is `.block-row`'s last flex child and a sibling of the focused
block's textarea, so focusing a block cannot shift it; `.block-children` indents
from the left only, so the cells line up at any depth. The flag reaches it as a
prop from `PageView`; `EditableBlockTree` must never read `BlockStampsContext`
itself, or the journal scroll and sidebar panels would grow the column too.

`.block-ref-badge` (the incoming-reference count) sits between `.block-text` and
the stamp cell, on rows with a count only. It is low-ink (`--color-text-muted`
on `--color-bg-subtle`), and it must not join `.block-stamp`'s under-600px
`display: none` — on touch it is the only route to the references popover.
`.block-ref-popover` copies `.block-menu`'s surface (z-index 60, same border,
shadow and `--radius-panel`), a pair `styles.test.ts` pins together.

## Two control families

Buttons and fields are styled by named class, and there is no bare
`input`/`select` element rule: a new control opts in by name.

- **Buttons** are pills (`--radius-pill`): `.btn-secondary` (bordered,
  `--color-bg-subtle`, hover to `--color-selected-bg`), `.btn-danger` (filled
  `--color-error-fill`, a fill-only token separate from the error text colour),
  and the quiet-until-hovered chrome trio (`.top-bar-menu-button`,
  `.sidebar-toggle-button`, `.help-button`) whose transparent border keeps hover
  from shifting layout. `.btn-secondary` carries its own padding, so call sites
  add none, and `.btn-danger` shares its disabled treatment.
- **Fields** are `.input-control` (text inputs, selects, textareas) and
  `.search-field` / `.search-field-input`, the top-bar search look extracted so
  `/files`' search is the same field as `Cmd-U`. The resting fill is
  `--color-bg-subtle`, lifting to `--color-bg-surface` on focus; per-call-site
  rules add geometry only. The colour exception is `.nav-sidebar-add input`,
  which sits on `.left-nav`'s own `--color-bg-subtle` and so takes the surface
  fill at rest.

Shared supporting and status copy in Files and Settings uses `p.settings-note`;
the `p` qualifier keeps `.settings-section p` specificity, so the later shared
rule can override Settings' paragraph reset.

Menus keep two idioms apart:

| | `.block-menu` | `.top-bar-menu` |
|---|---|---|
| Check slot | `.block-menu-item-check`, reserved on checkable items | none; every item starts at the padding edge |
| State signal | `aria-checked` on the item | the label flips (`Show timestamps` / `Hide timestamps`) |
| Role | `role="menuitemradio"` for a checkable item, else `role="menuitem"` | `role="menuitem"` |

An item whose state is in its text must not also claim `menuitemcheckbox`, or
the label and the announced checked state say the same thing twice.
`.top-bar-menu` items must keep `white-space: nowrap`: the menu shrink-to-fits
inside a button-sized relative parent, so without it a two-word label wraps past
the 160px `min-width`.

`.block-input` (the outline editor's per-block textarea) sits outside this
family: borderless and transparent, so a focused block reads as plain text
rather than a form field. While `field-sizing: content` applies, no code may set
an inline `height` on it. `useBlockDraft.ts`'s
`CSS.supports("field-sizing", "content")` check tests the identical declaration
to the `@supports` condition, so the fallback height logic and the native resize
never disagree about which one owns the box.

## Confirmations

Every confirmation prompt goes through `useConfirm`
(`web/src/components/ConfirmDialog.tsx`), which returns
`{ confirm(message, options?): Promise<boolean>, dialog: ReactNode }`. No
`window.confirm` call site may appear in `web/src`: iPadOS Safari suppresses it
in standalone (installed PWA) mode, turning a guarded destructive action into a
no-op or an unguarded one.

The owning component must render `dialog`, or `confirm()`'s promise never
settles and the action hangs instead of prompting. A hook that exposes a
confirm-backed handler therefore re-exports `dialog` to its caller, as
`useOutline` does for the large-selection delete prompt that `EditablePage`
renders. `confirm()` is asynchronous, so remote sync batches can land while a
dialog is open: handlers re-derive what they act on after the await.

## Focus and interactive affordances

One ring, everywhere a control can be focused:

```css
:focus-visible { outline: 2px solid var(--color-link); outline-offset: 1px; }
```

It is declared per component, next to that component's own rule; a grouped
selector list also defeats `ruleFor` in `styles.test.ts`.
`.asset-image-trigger` and `button.file-thumb` take `outline-offset: 2px` to
clear a rounded image corner.

Three exceptions, each commented in `styles.css`:

- `.top-bar-search-input` sets `outline: none` — its desktop-only 220px→320px
  width growth is the focus affordance, so the `@media (max-width: 600px)`
  block re-enables the ring.
- `DatePickerPopup`'s buttons get no ring: the popup is mouse-only, every
  element `preventDefault`ing on mousedown so the block textarea keeps focus.
  `styles.test.ts` asserts the absence.
- `.bullet` uses the standard ring. The dot sits inside a
  `4px solid transparent` border that `.bullet.closed` colours to signal a
  collapsed block, so any restyling must stay distinguishable from `.closed`.

Invariants that are easy to break without noticing:

- **Nav controls.** `.nav-link` styles both the `<a>` destinations and the
  `<button>` controls in the left nav (`App.tsx`, `SidebarNav.tsx`,
  `ThemeToggle.tsx`), so reading `styles.css` alone will not find every
  focusable control.
- **Content anchors.** `a.page-link`, external links and the `.page-title > a`
  heading link keep the UA ring; at the block line-height an offset ring
  collides with the line above.
- **The closed phone drawer.** Inside `@media (max-width: 600px)` it pairs
  `translateX(-100%)` with `visibility: hidden`, restored by `.left-nav.open`.
  The hamburger carries `aria-expanded` and `aria-controls="left-nav"`, and
  closing returns focus to it, guarded on the drawer's previous state because
  every `NavLink` calls `setNavOpen(false)`.
- **Clickable headings.** Page-title rename (`.page-title-edit`) and the
  Unlinked references collapse (`.section-toggle`) wrap their label in a real
  `<button>` inside the heading, with `font: inherit`, explicit
  `letter-spacing` and `text-transform`, and `display: block; width: 100%` so
  the header row stays the hit area (`styles.test.ts` pins the last two for
  `.section-toggle`). The trigger owns `aria-expanded` and marks its chevron
  `aria-hidden`. `.page-title-edit` must never take a fixed `aria-label`:
  accname walks the `<h1>`'s children, so a name on the button renames the
  page's heading.
- **Control boundary contrast.** `.btn-secondary`'s border falls below WCAG
  1.4.11's 3:1 ratio against a panel surface in both themes, accepted rather
  than fixed.
- **Containment.** Nothing `position: fixed` may render inside a box carrying
  `content-visibility` or `contain: layout`, which become the containing block
  for fixed descendants. `BlockMenu` and `Popover` therefore `createPortal` to
  `document.body`, and `e2e/popover-placement.spec.ts` asserts each lands at its
  click point. Adding containment anywhere means auditing what renders inside
  it. `.journal-day` carries none, and the comment on its rule records the
  measurement that rejected `content-visibility: auto`.
- **`.pdf-frame`** carries `contain: layout` for the opposite reason: a
  contained box offers no baseline, so the baseline-aligned `.block-row` takes
  its baseline from `.pdf-footer`'s text rather than a canvas inside the
  scroller. Its fullscreen overlay portals to `document.body`.
- **Embedded image caps.** `.asset-image` and `.asset-image-trigger` both cap at
  `max-width: 67%` of the text column, since an external URL renders as a bare
  `<img>` and an uploaded `/assets/` image is wrapped in the trigger. The inner
  image resets to `max-width: 100%` so the caps do not multiply, and the phone
  override back to full width (`@media (max-width: 600px)`) must stay after
  those rules, because a media query adds no specificity.
