# Floating table of contents (pkm-uwo5)

## Intent

A page with a `{{toc}}` block shows its contents as a card where the block
sits, near the top, so it scrolls away as soon as reading starts. On a long
page the contents should stay in view: a column on the right of the page
that holds its place while the text scrolls, in the manner of the
"contents" box on anil.recoil.org's notes pages. The right sidebar (the
shift-click stack) takes priority over it: while the sidebar is open the
floating contents is hidden, and it comes back when the sidebar closes.

## Goals

- In the main pane, a page with a `{{toc}}` block shows its contents in a
  sticky column at the right of the page card, while the right sidebar is
  closed and the pane is wide enough to give it a column.
- While the contents floats, the `{{toc}}` block itself shrinks to a small
  marker, so the list never shows twice.
- Whenever it does not float (sidebar open, pane too narrow, phone), the
  block renders the full card in place exactly as today. The list is always
  on screen once: never twice, never missing.
- Entries, nesting and links are today's: `tocEntries` derives them live
  from the page tree, and a link goes to `#<uid>`, so the existing
  scroll-and-flash handles the jump.

## Non-goals

- Highlighting the section being read (scroll-spy). A possible follow-up,
  in its own bean.
- A floating contents for pages opened in a sidebar panel: a panel has no
  room for a column, so it keeps the card.
- A contents for pages without a `{{toc}}` block. The block stays the
  opt-in, and its placement rule (below the leading `Attr::` run) is
  unchanged.

## Approaches

- **A (chosen): the code decides.** One yes/no, "the contents floats",
  computed from whether the right sidebar is open and how wide the main
  pane is. The floating column and the `{{toc}}` block both read that one
  answer, so "never both, never neither" holds by construction and is unit
  testable without a browser.
- **B: the stylesheet decides.** Render both always; CSS shows one from
  `.no-sidebar` and a width query. Less code, but the rule lives in two
  selectors and only a browser test can check it. Rejected for that.

## Design

- The decision is a Functional Core function of (right sidebar open, main
  pane width) returning whether the contents floats. It measures the pane,
  not the window, because collapsing the left nav changes the room as much
  as resizing does.
- Only the main pane offers floating: the main page view provides it, and a
  sidebar panel does not, so a panel's `{{toc}}` always renders the card.
- If a page has more than one `{{toc}}` block, the first in outline order
  floats; any other renders its card in place as today.
- While floating, the page card lays out as two columns: the outline, and a
  narrower contents column on its right that sticks while the page
  scrolls. A contents list taller than the window scrolls within its column
  (no truncation). When not floating, the outline takes the full width as
  now.
- The floating list's entries are 13px, two below the 15px body text (the
  in-place card's entries stay at body size); its "Table of Contents"
  header keeps the card's 12px.
- The marker is a small, muted line in place of the card (e.g. the "Table of
  Contents" header alone). Clicking the row still opens it for editing, as
  any block does.
- Editing a heading updates the floating list immediately, as the card does
  today.

## Left to the builder

- The minimum pane width for floating, as a named constant: the aim is that
  the outline keeps a comfortable reading width beside the column.
- How the pane width is observed (a `ResizeObserver` on the main pane is
  the expected route) and how the "floats" answer and the floating toc's uid
  reach the `{{toc}}` row without breaking the memoised rows (the
  `RootBlocksContext` comment in `TableOfContents.tsx` explains why that
  matters).
- Column width, sticky offset and card styling, in the existing `.toc`
  idiom and design tokens.
- A Playwright spec: floats on a wide pane with the sidebar closed; opening
  the sidebar hides it and restores the card; a link still jumps.
- Updating `docs/architecture/frontend-rendering.md` where `{{toc}}` is
  described, and `styling.md` if a token or layout invariant is added.
- `perf/check.sh frontend` before merge: the float must not re-render the
  outline's rows on resize or scroll.
