# Styling and theming (web/)

All styling is plain CSS in a single file, `web/src/styles.css` — no
framework, no CSS-in-JS. This doc owns the design tokens, the control
families, the confirmation pattern, and the focus and affordance invariants;
the SPA's structure around them is in [frontend.md](frontend.md). Design
tokens are custom properties on `:root`: a color system
(`--color-bg/-surface/-text*/-accent/-link/-tag/…`), a five-step radius
scale, and `--hljs-*` code tokens.

The radius steps are assigned by *role*, not by size, and the comments in
`styles.css` are the contract:

| Token | Size | Used for |
|---|---|---|
| `--radius-pill` | 999px | buttons, ghost icon buttons, search fields |
| `--radius-field` | 7px | text inputs, selects, textareas |
| `--radius-control` | 4px | inline code, block rows, badges, thumbs |
| `--radius-card` | 6px | embedded content |
| `--radius-panel` | 8px | floating menus, dropdowns, the main pane |

Block stamps add three band tokens — `--color-stamp-week`,
`-month`, `-year` — declared in all three theme blocks, warm-for-fresh
cooling toward neutral as material ages. The fourth band, `older`, is
deliberately unfilled: `stampBand` still returns `"older"` and the row still
carries a `.block-stamp-older` class, but no token and no background rule
back it, so it renders as plain text. In a mature database most rows are
"older" -- painting ink behind the commonest rows would be backwards, so the
strongest colour is reserved for the rare recent rows worth flagging. The
three tints are solid fills, not alpha, so a band stays predictable over
`.block-row:hover` and `.block-row.focused`. `.block-stamp` is the control
class; below the 600px breakpoint the whole column is `display: none`.

The stamp cell is `.block-row`'s last flex child — after `.block-text`, or
after the focused block's textarea. `.block-children` indents from the left
only, so every row shares a right edge and the cells form a true column at
any nesting depth. Being a sibling of the textarea, not of the row, means
focusing a block cannot shift it. The flag reaches it as a prop from
`PageView` alone — `EditableBlockTree` must never read `BlockStampsContext`
itself, or the journal scroll and sidebar panels would grow the column too.

`.block-ref-badge` (the incoming-reference count) sits between
`.block-text` and the stamp cell but is the column's opposite: sparse,
rendered only on rows with a count, so it needs no empty placeholder.
It is deliberately low-ink (`--color-text-muted` on `--color-bg-subtle`) so
a stamp's freshness tint stays the louder signal, and it must **not** join
`.block-stamp`'s under-600px `display: none` — on touch it is the only route
to the references popover. `.block-ref-popover` copies `.block-menu`'s
surface (z-index 60, same border, shadow and `--radius-panel`);
`styles.test.ts` pins the pair together.

Theming is three-way: light by default, OS dark via
`@media (prefers-color-scheme: dark)` (which works with zero JS), and an
explicit `data-theme` override stamped on `<html>` by `useTheme.ts`
(system → light → dark cycle, persisted to localStorage). `color-scheme` is
declared per theme; without it Chrome paints `select` and date widgets light
whatever the CSS says.

## Two control families

Buttons and fields are styled by named class, and there is deliberately **no
bare `input`/`select` element rule**: a new control opts in by name rather
than silently inheriting a look, or silently getting none.

- **Buttons** are pills (`--radius-pill`): `.btn-secondary` (bordered,
  `--color-bg-subtle`, hover to `--color-selected-bg`), `.btn-danger` (filled
  `--color-error-fill`), and the quiet-until-hovered chrome trio
  (`.top-bar-menu-button`, `.sidebar-toggle-button`, `.help-button`) whose
  transparent border keeps hover from shifting layout. `.btn-secondary`
  carries its own padding; it once had none, so bare call sites rendered at
  UA metrics.

  The danger family mirrors the same disabled treatment:
  `.btn-danger:hover:not(:disabled)` suppresses hover feedback once
  busy/disabled, and `.btn-danger:disabled` uses the same 0.35 opacity and
  default cursor as `.btn-secondary:disabled`. The left nav is the exception
  to watch for: its `.nav-link` class covers both `<a>` and `<button>` (see
  below).
- **Fields** are `.input-control` (text inputs, selects, textareas) and
  `.search-field` / `.search-field-input`. The latter is the top-bar search
  look, extracted so `/files`' search is literally the same field as `Cmd-U`
  rather than a lookalike. The resting fill is `--color-bg-subtle`, lifting
  to `--color-bg-surface` on focus; per-call-site rules add geometry only.

  Shared supporting and status copy in Files and Settings uses
  `p.settings-note`. The `p` qualifier keeps `.settings-section p`
  specificity, so the later shared rule can set the muted colour and tighter
  top margin without undoing Settings' paragraph reset.

  The one colour exception is the left nav's `Add page…` input. It sits *on*
  `--color-bg-subtle` (`.left-nav`'s own background), so it takes the surface
  fill at rest; otherwise only its border would separate it from the nav. Its
  focus is then carried by the border colour and the ring alone.

`--color-error-fill` is a **fill-only** token, separate from the error text
colour. Reusing one red for both made dark-theme Delete buttons read as
coral: two colour tokens for two jobs.

Menus keep two idioms apart. `BlockMenu` items reserve a check slot
(`.block-menu-item-check`). `.top-bar-menu` items are plain
`role="menuitem"` entries that flip their label text
("Show timestamps" / "Hide timestamps") with no reserved-width slot;
`styles.test.ts` asserts the slot's absence. An item whose state is in its
text must not also claim `menuitemcheckbox`, or the label and the announced
checked state say the same thing twice. `.top-bar-menu` items must
also keep `white-space: nowrap`: the menu is absolutely positioned inside a
button-sized relative parent, so its shrink-to-fit width resolves at
min-content — the widest single *word* — and any two-word label wraps once
text outgrows the 160px `min-width`. Nowrap makes min-content equal
max-content, so new menu items cost width, not height.

## Confirmations

Every confirmation prompt goes through `useConfirm`
(`web/src/components/ConfirmDialog.tsx`), which returns
`{ confirm(message, options?): Promise<boolean>, dialog: ReactNode }`. There
are no `window.confirm` call sites left in `web/src`, and new ones must not
appear. iPadOS Safari has suppressed `window.confirm` in standalone (installed
PWA) mode, which silently turns a guarded destructive action into either a
no-op or an unguarded one, depending on what it returns.

The cost of the hook is that the owning component must render `dialog`
somewhere in its tree, or `confirm()`'s promise never settles and the action
hangs instead of prompting. Hooks that expose a confirm-backed handler
therefore re-export `dialog` to their caller — `useOutline` does this for the
large-selection delete prompt, and `EditablePage` renders it.

Because the prompt is now asynchronous where `window.confirm` blocked the main
thread, remote sync batches can land while a dialog is open. Handlers must
re-derive what they act on after the await rather than closing over uids
captured before it.

## Focus and interactive affordances

One ring, everywhere a control can be focused:

```css
:focus-visible { outline: 2px solid var(--color-link); outline-offset: 1px; }
```

It is declared **per component, next to that component's own rule**, rather
than as one grouped selector list. Locality beats brevity in a single
1000-line stylesheet, and the grouped-rule alternative also trips `ruleFor`
(below). Resolved colours are `#c25a28` light and `#e8935a` dark. Every
control uses `outline-offset: 1px`; the one deviation is
`.asset-image-trigger` at 2px, to clear an embedded image's rounded corner.

Three deliberate exceptions, all commented in `styles.css` so an audit
doesn't "fix" them:

- `.top-bar-search-input` sets `outline: none` — its 220px→320px width growth
  is the focus affordance. That growth is desktop-only: below the 600px phone
  breakpoint the field must shrink instead of overflow (`.search-field`'s
  `min-width: 0`), so growth stops being a usable focus cue and the
  `@media (max-width: 600px)` block re-enables the ring there.
- `DatePickerPopup`'s buttons get no ring. The popup is mouse-only by design
  (every element `preventDefault`s on mousedown so the block textarea keeps
  focus), and Tab inside a block indents, so a ring there is unreachable.
  `styles.test.ts` asserts its *absence*.
- `.bullet` uses the standard ring, for a second reason beyond the palette
  clash. The bullet is a 5px dot inside a `4px solid transparent` border, and
  `.bullet.closed` signals *collapsed with hidden children* by colouring that
  border. Chrome's default ring hugs the dot the same way, so an unstyled
  focused bullet reads as a collapsed block. Any future restyling here must
  stay distinguishable from `.closed`.

Four traps when working on this:

- **Auditing the stylesheet alone is not enough.** `.nav-link` is applied to
  both the `<a>` destinations and the `<button>` controls in the left nav,
  and those are the app's first eight tab stops. A class-by-class read of
  `styles.css` looking for `<button>` selectors misses it completely. Drive
  the running app instead: `press Tab` in a loop and read
  `document.activeElement.className` plus
  `getComputedStyle(el).outlineColor`. Computed style reflects
  `:focus-visible`, and CDP's synthetic Tab does establish keyboard modality.
- **Ordinary content anchors keep the UA ring, not the custom one.**
  `a.page-link`, external links and the `.page-title > a` heading link were
  considered and declined: at the block line-height a 2px offset ring
  collides with the line above and repeats per line box on a wrapped link.
- **The closed phone drawer must be `visibility: hidden`.** Inside
  `@media (max-width: 600px)` the nav pairs its `translateX(-100%)` with
  `visibility: hidden` (restored by `.left-nav.open`, and transitioned so
  the slide-out still shows) — transform alone leaves the drawer's links in
  the tab order (symptom table). The hamburger carries `aria-expanded` and
  `aria-controls="left-nav"`, and closing the drawer returns focus to it,
  guarded on the drawer's previous state since every `NavLink` calls
  `setNavOpen(false)` on every click.
- **Clickable headings wrap their label in a real `<button>` inside the
  heading.** Page-title rename (`.page-title-edit`), the Unlinked references
  collapse (`.section-toggle`) and `BacklinksSection`'s `.filter-toggle` all
  use this pattern — a heading's own `onClick` is unreachable from the
  keyboard (symptom table). The classes inherit the heading's type
  (`font: inherit` plus explicit `letter-spacing` and `text-transform`,
  which the shorthand does not carry) and take
  `display: block; width: 100%`, so the whole header row stays the hit area
  (`styles.test.ts` asserts both properties); the collapsible trigger owns
  `aria-expanded` and marks its chevron `aria-hidden`. `.page-title-edit` must stay
  named by its content, never a fixed `aria-label`: accname walks the
  `<h1>`'s children, so an explicit name on the button renames the page's
  heading in every real browser — verified in Chromium; jsdom cannot
  reproduce it. When a title word collides with a dialog button's name in a
  test, scope the query to its dialog rather than rename the control.

**Control boundary contrast is a known, measured deviation from WCAG 1.4.11.**
`.btn-secondary`'s border is 1.30:1 against a panel surface in dark and
1.29:1 in light. Reaching 3:1 would need a control-border token near
`#6e7a88` dark / `#959ea4` light, i.e. a visibly grey outline on every button
and input in both themes, which was judged to cost more than it buys.

Two other stylesheet invariants that are easy to break without noticing:

- **Embedded images cap at two-thirds of the text column** (`.asset-image`
  and `.asset-image-trigger`, both `max-width: 67%`). An external URL renders
  as a bare `<img>`, while an uploaded `/assets/` image is wrapped in the
  expansion trigger, so both boxes carry the cap and the outermost one
  decides. That is why the inner image resets to `max-width: 100%`: without
  the reset the two caps multiply to 4/9. The phone override back to full
  width (`@media (max-width: 600px)`) must stay *after* those rules, because
  a media query adds no specificity and source order is what wins.
- **The left nav's rules get their space from flexbox, not padding.**
  `.left-nav` has an 8px flex `gap`, so a separator like `.nav-section-start`
  declares only `padding-top` below itself: 12px, the free 8px above plus
  `.nav-link`'s own 4px. That keeps the text equidistant from the rule.

`styles.test.ts` guards these as text-level drift assertions against the raw
stylesheet. Its `ruleFor(selector)` builds an **unanchored** regex and
returns the first match, so a selector appearing as the non-first member of a
grouped rule silently returns the *group's* body. Use `rulesFor`, which joins
every matching rule, for classes styled in more than one place. Use
`mediaRulesFor(query, selector)` for anything inside an `@media` block,
since `ruleFor` stops at the first `}` — inside a media block, the end of
its first nested rule.

## When something looks wrong

Each row is a failure this system has actually produced, and the invariant
its fix installed. The bean has the full investigation.

| Symptom | Cause | Ref |
|---|---|---|
| On a phone, Tab lands on invisible controls before anything visible | the closed drawer used `transform: translateX(-100%)` alone, which keeps its links tabbable as the page's first tab stops; it must also toggle `visibility` | pkm-cq32 |
| Page-title rename and the Unlinked references collapse cannot be reached from the keyboard | `onClick` sat on a non-focusable `<h1>`/`<h2>`; the label must be a real `<button>` inside the heading | pkm-cq32 |
