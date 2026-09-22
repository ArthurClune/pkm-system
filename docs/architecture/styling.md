# Styling and theming (web/)

All styling is plain CSS in a single file, `web/src/styles.css` — no
framework, no CSS-in-JS. This doc owns the design tokens, the control
families, the confirmation pattern, and the focus and affordance invariants;
the SPA's structure around them is in [frontend.md](frontend.md). Failures and
their fixes are indexed by symptom in [troubleshooting.md](../troubleshooting.md).

## Tokens and theming

Design tokens are custom properties on `:root`: a color system
(`--color-bg/-surface/-text*/-accent/-link/-tag/…`), a five-step radius
scale, and `--hljs-*` code tokens.

Page links are `--color-link` by default, but a `[[Tree/Page]]` ref can take
a per-tree colour: `PageLink` stamps the lowercased prefix before the title's
first `/` as `data-ns`, and `styles.css` maps a few prefixes onto four group
tokens. Tags and attribute names never take a tree colour. Adding a tree is a
stylesheet-only change (add the prefix to a group's selector list);
`pageNamespace` does not know which trees are coloured.

| Token | Trees |
|---|---|
| `--color-link-cloud` | aws, azure, gcp |
| `--color-link-ai` | claude, llm, gpt |
| `--color-link-work` | project, uos |
| `--color-link-reading` | paper, book, article |

The radius steps are assigned by role; the table below and the comments in
`styles.css` agree:

| Token | Size | Used for |
|---|---|---|
| `--radius-pill` | 999px | buttons, ghost icon buttons, search fields |
| `--radius-field` | 7px | text inputs, selects, textareas |
| `--radius-control` | 4px | inline code, block rows, badges, thumbs |
| `--radius-card` | 6px | embedded content |
| `--radius-panel` | 8px | floating menus, dropdowns, the main pane |

Block stamps add three band tokens — `--color-stamp-week`, `-month`, `-year`
— declared in all three theme blocks, warm-for-fresh cooling toward neutral
as material ages. The fourth band, `older`, has no token and no background
rule, so it renders as plain text; `stampBand` still returns `"older"` and
the row still carries a `.block-stamp-older` class. The three tints are solid
fills, not alpha, so a band stays predictable over `.block-row:hover` and
`.block-row.focused`. `.block-stamp` is the control class; below the 600px
breakpoint the whole column is `display: none`.

The stamp cell is `.block-row`'s last flex child — after `.block-text`, or
after the focused block's textarea. `.block-children` indents from the left
only, so every row shares a right edge and the cells form a true column at
any nesting depth. Being a sibling of the textarea, not of the row, means
focusing a block cannot shift it. The flag reaches it as a prop from
`PageView` alone; `EditableBlockTree` must never read `BlockStampsContext`
itself, or the journal scroll and sidebar panels would grow the column too.

`.block-ref-badge` (the incoming-reference count) sits between `.block-text`
and the stamp cell, rendered only on rows with a count, so it needs no empty
placeholder. It is low-ink (`--color-text-muted` on `--color-bg-subtle`) so a
stamp's tint stays the louder signal, and it must not join `.block-stamp`'s
under-600px `display: none` — on touch it is the only route to the references
popover. `.block-ref-popover` copies `.block-menu`'s surface (z-index 60,
same border, shadow and `--radius-panel`); `styles.test.ts` pins the pair
together.

Theming is three-way: light by default, OS dark via
`@media (prefers-color-scheme: dark)` (which works with zero JS), and an
explicit `data-theme` override stamped on `<html>` by `useTheme.ts`
(system → light → dark cycle, persisted to localStorage). `color-scheme` is
declared per theme; without it Chrome paints `select` and date widgets light
whatever the CSS says.

## Two control families

Buttons and fields are styled by named class, and there is no bare
`input`/`select` element rule: a new control opts in by name.

- **Buttons** are pills (`--radius-pill`): `.btn-secondary` (bordered,
  `--color-bg-subtle`, hover to `--color-selected-bg`), `.btn-danger` (filled
  `--color-error-fill`), and the quiet-until-hovered chrome trio
  (`.top-bar-menu-button`, `.sidebar-toggle-button`, `.help-button`) whose
  transparent border keeps hover from shifting layout. `.btn-secondary`
  carries its own padding, so call sites add none. `.btn-danger` shares
  `.btn-secondary`'s disabled treatment.
- **Fields** are `.input-control` (text inputs, selects, textareas) and
  `.search-field` / `.search-field-input`. The latter is the top-bar search
  look, extracted so `/files`' search is the same field as `Cmd-U`. The
  resting fill is `--color-bg-subtle`, lifting to `--color-bg-surface` on
  focus; per-call-site rules add geometry only.

  Shared supporting and status copy in Files and Settings uses
  `p.settings-note`. The `p` qualifier keeps `.settings-section p`
  specificity, so the later shared rule can set the muted colour and tighter
  top margin without undoing Settings' paragraph reset.

  The one colour exception is `.nav-sidebar-add input`, the left nav's
  `Add page…` field. It sits *on* `--color-bg-subtle` (`.left-nav`'s own
  background), so it takes the surface fill at rest; otherwise only its
  border would separate it from the nav. Its focus is then carried by the
  border colour and the ring alone.

`--color-error-fill` is a fill-only token, separate from the error text
colour.

Menus keep two idioms apart:

| | `.block-menu` | `.top-bar-menu` |
|---|---|---|
| Check slot | `.block-menu-item-check`, reserved on checkable items | none; every item starts at the padding edge |
| State signal | `aria-checked` on the item | the label flips (`Show timestamps` / `Hide timestamps`) |
| Role | `role="menuitemradio"` for a checkable item, else `role="menuitem"` | `role="menuitem"` |

An item whose state is in its text must not also claim `menuitemcheckbox`, or
the label and the announced checked state say the same thing twice.
`.top-bar-menu` items must keep `white-space: nowrap`: the menu shrink-to-fits
inside a button-sized relative parent, so without it a two-word label wraps
once the text outgrows the 160px `min-width`.

`.block-input` (the outline editor's per-block textarea) sits outside this
family: borderless and transparent, so a focused block reads as plain text
rather than a form field. While `field-sizing: content` applies (the
`@supports` block right after it), no code may set an inline `height` on it,
or it would fight the browser's own auto-grow. `useBlockDraft.ts`'s
`CSS.supports("field-sizing", "content")` check tests the identical
declaration as that `@supports` condition, so the JS fallback height logic
and the native resize can never disagree about which one owns the box.

## Confirmations

Every confirmation prompt goes through `useConfirm`
(`web/src/components/ConfirmDialog.tsx`), which returns
`{ confirm(message, options?): Promise<boolean>, dialog: ReactNode }`. There
are no `window.confirm` call sites in `web/src`, and new ones must not appear:
iPadOS Safari suppresses `window.confirm` in standalone (installed PWA) mode,
which silently turns a guarded destructive action into either a no-op or an
unguarded one, depending on what it returns.

The cost of the hook is that the owning component must render `dialog`
somewhere in its tree, or `confirm()`'s promise never settles and the action
hangs instead of prompting. Hooks that expose a confirm-backed handler
therefore re-export `dialog` to their caller — `useOutline` does this for the
large-selection delete prompt, and `EditablePage` renders it.

`confirm()` is asynchronous, so remote sync batches can land while a dialog is
open. Handlers must re-derive what they act on after the await rather than
closing over uids captured before it.

## Focus and interactive affordances

One ring, everywhere a control can be focused:

```css
:focus-visible { outline: 2px solid var(--color-link); outline-offset: 1px; }
```

It is declared per component, next to that component's own rule, rather than
as one grouped selector list; a grouped selector also defeats `ruleFor` in
`styles.test.ts`. Resolved colours are `#c25a28` light and `#e8935a` dark.
Two controls take `outline-offset: 2px` to clear a rounded image corner:
`.asset-image-trigger` and `button.file-thumb`.

Three exceptions, each commented in `styles.css`:

- `.top-bar-search-input` sets `outline: none` — its 220px→320px width growth
  is the focus affordance. That growth is desktop-only. Below the 600px phone
  breakpoint the field shrinks instead of overflowing (`.search-field`'s
  `min-width: 0`), so the `@media (max-width: 600px)` block re-enables the
  ring there.
- `DatePickerPopup`'s buttons get no ring. The popup is mouse-only (every
  element `preventDefault`s on mousedown so the block textarea keeps focus),
  and Tab inside a block indents, so a ring there is unreachable.
  `styles.test.ts` asserts its absence.
- `.bullet` uses the standard ring. The bullet is a 5px dot inside a
  `4px solid transparent` border, and `.bullet.closed` signals *collapsed with
  hidden children* by colouring that border. Chrome's default ring hugs the
  dot the same way, so an unstyled focused bullet reads as a collapsed block.
  Any restyling here must stay distinguishable from `.closed`.

Invariants that are easy to break without noticing:

- **Nav controls.** `.nav-link` styles both the `<a>` destinations and the
  `<button>` controls in the left nav (`App.tsx`, `SidebarNav.tsx`,
  `ThemeToggle.tsx`), and those are the app's first tab stops. A
  selector-by-selector read of `styles.css` will not find every focusable
  control.
- **Content anchors.** `a.page-link`, external links and the `.page-title > a`
  heading link keep the UA ring: at the block line-height a 2px offset ring
  collides with the line above and repeats per line box on a wrapped link.
- **The closed phone drawer.** Inside `@media (max-width: 600px)` the closed
  drawer pairs `translateX(-100%)` with `visibility: hidden`, restored by
  `.left-nav.open` and transitioned so the slide-out still shows. The
  hamburger carries `aria-expanded` and `aria-controls="left-nav"`, and
  closing returns focus to it, guarded on the drawer's previous state because
  every `NavLink` calls `setNavOpen(false)`.
- **Clickable headings.** Page-title rename (`.page-title-edit`) and the
  Unlinked references collapse (`.section-toggle`) wrap their label in a real
  `<button>` inside the heading. Both take `font: inherit` plus explicit
  `letter-spacing` and `text-transform`, which the shorthand does not carry,
  and `display: block; width: 100%` so the whole header row stays the hit
  area (`styles.test.ts` pins those two declarations for `.section-toggle`).
  The collapsible trigger owns `aria-expanded` and marks its chevron
  `aria-hidden`. `.page-title-edit` must stay named by its content and never
  take a fixed `aria-label`: accname walks the `<h1>`'s children, so an
  explicit name on the button renames the page's heading.
- **Control boundary contrast** is a known deviation from WCAG 1.4.11.
  `.btn-secondary`'s border falls below the 3:1 ratio against a panel surface
  in both themes, accepted rather than fixed.
- **Containment.** Nothing `position: fixed` may render inside a
  layout-contained box. `content-visibility` and `contain: layout` make their
  element the containing block for fixed descendants, so a surface positioned
  from viewport coordinates paints displaced by that box's own offset.
  `BlockMenu` and `Popover` therefore `createPortal` to `document.body`
  instead of rendering in place, and `e2e/popover-placement.spec.ts` asserts
  each lands at its click point. Adding containment anywhere in the app means
  auditing what renders inside it first. `.journal-day` carries none, and the
  comment on its rule records the measurement that rejected
  `content-visibility: auto` there.
- **`.pdf-frame`** is the one box that carries `contain: layout`, for the
  opposite reason: a layout-contained box offers no baseline, so the
  baseline-aligned `.block-row` around it takes its baseline from
  `.pdf-footer`'s text rather than from a canvas inside the scroller. The
  fullscreen overlay portals to `document.body`, so nothing fixed renders
  inside the frame.
- **Embedded image caps.** `.asset-image` and `.asset-image-trigger` both cap
  at `max-width: 67%` of the text column. An external URL renders as a bare
  `<img>`, while an uploaded `/assets/` image is wrapped in the expansion
  trigger, so both boxes carry the cap and the outermost one decides. The
  inner image resets to `max-width: 100%`, without which the two caps
  multiply to 4/9. The phone override back to full width
  (`@media (max-width: 600px)`) must stay *after* those rules, because a media
  query adds no specificity and source order is what wins.
