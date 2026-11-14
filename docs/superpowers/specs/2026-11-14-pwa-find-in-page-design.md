# Find in page for the installed app (pkm-06os)

## Intent

An installed pkm window (Mac Safari "Add to Dock", an installed Chrome app,
the iPad home-screen app) has no browser chrome, so Cmd-F and Cmd-G do
nothing. Arthur wants them to behave as they do in a browser tab: Cmd-F
finds text on the current page, Cmd-G goes to the next match.

## Goals

- Cmd-F opens a find bar, top-right, pre-filled with the page's current
  selection when there is one, its query selected.
- Cmd-G or Enter: next match. Shift-Cmd-G or Shift-Enter: previous match.
  Both wrap. The bar shows "n of m" ("No matches" when m is 0).
- Escape closes the bar, clears the highlights, and puts focus back where
  it was.
- Case-insensitive match over the rendered text of the main pane and the
  right sidebar.

## Non-goals and anti-goals

- In a normal browser tab the keys stay the browser's: nothing is bound
  unless `display-mode: standalone` matches.
- No regex, whole-word or case-sensitive options.
- Collapsed children and anything not rendered are not searched, as in a
  browser.
- Anti-goal: find must never change the outline's DOM or move the editor's
  selection while searching. Wrapping matches in `<mark>` or calling
  `window.find()` would do one or the other.

## Approaches

| Approach | Trade-off |
|---|---|
| CSS Custom Highlight API (`CSS.highlights`) over `Range`s built from a text-node walk | **Picked.** Paints matches without touching the DOM React owns. Safari 17.2+, Chrome 105+ |
| Wrap matches in `<mark>` | React re-renders would drop or fight the marks |
| `window.find()` | Non-standard, moves the selection and focus into the editor |

## Decided

- Opening the bar moves focus into its input, which blurs an editing
  block's textarea; the block then renders as text and is searchable like
  any other.
- Matches are recomputed when the query changes and when the searched
  regions' DOM changes (a sync edit, navigation), keeping the current
  index where it still exists.
- The current match gets a distinct highlight and is scrolled into view
  (`block: "nearest"`).

## Builder's calls (Claude's, flag if wrong)

- Escape returns focus to the element focused before Cmd-F if it is still
  on the page. If that was a block's textarea, it is gone by then; the
  block is re-entered for editing through its normal click path, so the
  caret lands at the end of the block rather than where it was.
- Pressing Cmd-F with the bar already open re-selects the query, as
  browsers do.
- Where `CSS.highlights` is missing the bar still opens and counts, and
  scrolls to matches without painting them.
