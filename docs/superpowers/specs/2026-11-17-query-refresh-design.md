# Query block Refresh button

Bean: pkm-p47v. A small change; this is the short design.

## Intent

Query table cells are editable, so an edit can take a row out of what the
query matches or move where it sorts. Arthur does not want results to
re-run under him as he edits; he wants to re-run them when he chooses, with
a Refresh button in the query block's header.

## What exists

- `QueryResults` loads records on mount, when the expression changes, and
  on a sync resync (`useResync` bumps a `generation` that is part of the
  load key). A cell write patches its record in place; nothing refetches.
- The first cell edit freezes the rows (`ViewState.frozen`), and
  `holdRecords` keeps a frozen row a refetch drops. Only a change to the
  live view (filter, sort, view, columns, reset) releases the freeze.

## Goals

- A `Refresh` button in `.query-header`, beside the view buttons, shown
  whenever the block is mounted (before results land and after an error
  too, where it acts as a retry).
- A click re-runs the query: it bumps the same `generation` a resync does,
  so records refetch, and `/api/query` refetches when the blocks view
  shows.
- When the refreshed records land, the freeze is released: rows edited out
  of the query leave, sort and filter apply again, and a view or column
  list the first edit pinned follows the data again. The live view's
  unsaved filter, sort and columns are untouched.
- The old rows stay on screen until the new records land: no flash, and no
  re-sort against stale records at the click.

## Non-goals and anti-goals

- Cell edits never refetch. A test pins it.
- A resync's automatic refetch keeps holding rows as today; only Refresh
  releases.
- No auto-refresh, no "results may be stale" indicator.

## Approaches

1. **Release on the refreshed load's landing (chosen).** The click records
   the load current at the click; the first records that land for any
   other load release the hold in the same step. Rows move once, onto
   fresh data. A resync that supersedes the refresh's request still
   releases, because its load also differs from the one at the click.
2. Release at the click, then refetch. Rows re-sort against patched,
   pre-refresh records, then move again when the new records land: two
   jumps, and rows that left the query linger until the load.
3. Remount the block (key change). Simplest, but it drops the reader's
   unsaved filter, sort and columns, and flashes the empty state.

## Shape (builder's latitude within this)

- `ViewEvent` gains a `release` step (`frozen: null`, live untouched);
  `stepQueryView` already clears `held` when `frozen` is null.
- `QueryBlockState` gains the load a pending refresh was clicked on
  (null when none). A `refresh` event sets it unless one is already
  pending; `recordsLanded` for a different load releases before
  `holdRecords` runs, so a released view keeps no held records, then
  clears it. `recordsFailed` leaves it pending, so the hold stays and the
  next successful load releases. A cell edit that freezes rows while a
  Refresh is pending cancels it: the refreshed records were requested
  before that edit, and releasing on them would move the row the reader
  just wrote under them (controller's call during review).
- This adds transitions to the query block machine, so the query view
  property (`web/src/props/tables/`) gets a refresh step in its draws and
  model, a reach label with a floor, and a teeth mutant that fails it.
- Unit tests for the reducer and `stepView`; a `QueryResults` test that a
  click refetches and that a cell write does not; an e2e spec that edits a
  row out of a query, sees it held, clicks Refresh and sees it gone.
- Docs: `frontend.md`'s query block section states that only Refresh (and
  a view change) releases a hold; the Help page mentions the button if it
  documents query tables.
