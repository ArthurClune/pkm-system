# Roam-look restyle — design

**Date:** 2026-07-10
**Status:** approved
**Source:** the user's custom Roam Research CSS, reviewed and triaged; this spec
covers only the parts agreed for porting.

## Goal

Restyle the web app to match the visual character of the user's customised
Roam graph: warm grey-blue canvas, page content on a white card, orange page
links, purple external links, muted tags, softer bullets. Light and dark
themes both get the treatment. No behavioural changes.

## Explicitly out of scope

- Custom fonts (the Roam font block was commented out; keep the system stack).
- Namespace-coloured page refs (`Book/`, `Project/`, `UoS/`…) — dropped, no bean.
- Tag-tinted blocks (`#claim`, `#question`, `#evidence`…) — dropped, no bean.
- Kanban, Roam query chrome, checkbox styling, bracket hiding (n/a or already
  the app's behaviour).
- Mermaid sizing (belongs to bean pkm-pekk).
- A user custom-CSS facility — the look is baked into the default theme.

## Design

### 1. Palette tokens — light theme

Rewire the `:root` block in `web/src/styles.css`:

| Token | New value | Notes |
|---|---|---|
| `--color-bg` | `#F8F9FB` | warm grey-blue app canvas |
| `--color-bg-surface` | `#ffffff` | unchanged; card + popups |
| `--color-text` | `#3f4758` | warm ink |
| `--color-text-muted` / `--color-text-secondary` / `--color-text-faint` | derived from `#7086A9` | three steps of the same hue |
| `--color-border` family | from `#dbe4e8` / `#e5ecf1` | subtle warm-grey borders |
| `--color-link` (new) | `#ec6f35` | page refs, weight 600 |
| `--color-link-ext` (new) | `#7056F2` | external links, weight 600 |
| `--color-tag` (new) | `#9DAFCA` | tags |
| `--color-accent` | orange family (`#ec6f35`) | UI chrome: focus, drop indicator, buttons |
| `--color-highlight-bg`, `::selection` | `#fcc1786d` | warm orange wash |

Other functional tokens (`--color-error`, banner, hljs) unchanged. Existing
`--color-accent` consumers that are page links move to `--color-link`;
plain `<a>` (external) moves to `--color-link-ext`.

### 2. Palette tokens — dark theme

Neutrals (backgrounds, borders, text) stay as today. Accents retuned in both
dark blocks (media query + `[data-theme="dark"]`):

- `--color-link`: softened orange ≈ `#ff9d5c`
- `--color-link-ext`: lighter purple ≈ `#a394f8`
- `--color-tag`: dimmed slate ≈ `#6f80a0`
- `--color-accent`: the dark orange
- selection/highlight: dim amber (keep contrast with `--color-text`)

Exact values may be nudged during visual verification; the constraint is
WCAG-reasonable contrast on the dark surface.

### 3. Card layout (resolves bean pkm-7cbq)

- `.main-pane` content renders on a card: `--color-bg-surface` background,
  `1px solid --color-border-subtle`, `6px` radius, soft shadow
  (`rgba(var(--shadow-rgb), …)`), internal padding ≈ `30px 50px 50px`,
  ~`10px` top margin.
- The grey `--color-bg` canvas shows around the card. Content max-width stays
  ~800px; the previous large empty left gutter is replaced by the card plus
  modest margins (the pkm-7cbq "reduce to ~1/3" ask).
- The top bar sits on the canvas above the card.
- Phone breakpoint (<600px): card chrome removed — full-bleed as today.
- The journal view (stacked days) shares the same card treatment: one card
  around the whole scroll of days, not one card per day.

### 4. Typography

- Body font family and size unchanged.
- Headings inside the outline: H1 `1.8rem`/600, H2 `1.6rem`/600,
  H3 `1.4rem`/400 in `--color-text-secondary` (lighter, not bolder).
- `.page-title` keeps its size but adopts the header weight (600).

### 5. Bullets

- Replace the text glyph bullet with a styled empty `<span class="bullet">`:
  5px circle, soft blue-grey fill (`#E3ECF2`; dark: a low-contrast slate
  token), `background-clip: content-box` + transparent border so the hit
  area stays comfortable.
- Collapsed block with children: the bullet shows a visible ring
  (border in a slightly darker tone) — the Roam "closed bullet" affordance.
- Markup touch in `BlockTree.tsx` / `EditableBlockTree.tsx` only (empty span
  instead of `•` text; a `closed`/`has-children` class as needed). Drag
  handle (`draggable` on the bullet) and click behaviour unchanged.

### 6. Detail styles

- **Block refs:** remove the dashed underline; add a `::before` tick-bar —
  2px wide, 10px tall, rounded, `--color-link`, 6px right margin.
  Unresolved refs keep the muted colour.
- **Backlink / query / unlinked items:** card style — background
  `--color-bg-subtle`, `1px` border, `6px` radius, `8px` padding, small
  vertical margins — replacing the left-border strip.

## Error handling

None — pure presentation. No new runtime states.

## Testing & verification

- `cd web && pnpm test -- --run` and `pnpm typecheck` must pass; bullet
  markup change may require updating `BlockTree`/`EditableBlockTree` tests
  that assert on the glyph.
- Visual verification in the running app: light and dark, at desktop,
  ~900px (sidebar overlay), and <600px (phone) widths; check page view,
  journal view, search modal, right sidebar, backlinks, code blocks.
- On completion, mark bean pkm-7cbq completed (superseded by the card
  layout) with a note.
