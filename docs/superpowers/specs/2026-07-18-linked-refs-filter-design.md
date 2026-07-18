# Linked References filter — design (pkm-m4an)

Bean: `pkm-m4an` — in the "Linked references" section at the end of a page,
filter items for/against any page reference or tag they contain (e.g. filter
out `#Paper`, filter for `#[[Constitutional AI]]`).

## Decision summary

Roam-style chip panel, ephemeral state, **fully client-side** filtering over
the complete backlink set (loaded on demand). No server or API changes.

Rejected alternatives:

- **Server-side filtering** (`bl_include`/`bl_exclude` params + co-ref
  aggregation): correct at any scale but adds API surface, response-model
  churn, and openapi/type regen for scalability a personal PKM doesn't need.
  Can be retrofitted later without UX changes if a page ever gets
  pathological.
- **Filter loaded groups only**: cheapest, but chip counts lie and
  "filter for" can silently miss matches sitting on unloaded pages.

## Architecture

Two pieces, FCIS-split:

### Functional core — `web/src/components/backlinkFilter.ts`

Pure functions, no I/O. Input: the loaded `BacklinkGroup[]`, the current
page title, and filter state `{ include: string[]; exclude: string[] }`.
Output: visible groups and the chip list.

- **Ref set per item** = `extractRefs(item.text)` ∪ `extractRefs(bc)` for
  each breadcrumb string. Breadcrumbs are the item's ancestor blocks' raw
  text (server sends the full trail), so a block nested under
  `Papers to read #Paper` inherits `Paper`. Uses the existing
  `web/src/grammar/refs.ts` `extractRefs`, which mirrors the server's
  `refs.py` exactly (shared fixture-pinned) — no drift between what the
  server indexes and what the client filters on.
- **Chips merge kinds**: `#Paper`, `[[Paper]]`, and `Paper::` are one chip
  keyed by title. The current page's own title is excluded (it matches
  every item by definition).
- **Visibility**: item visible ⇔ its ref-title set contains **all**
  included titles (AND) and **none** of the excluded ones. Group visible ⇔
  ≥1 visible item.
- **Chip counts** recompute against the currently *visible* items (Roam
  behaviour: a chip shows what selecting it would leave).
- Ref extraction is memoized per item uid/text (extraction runs on every
  filter change otherwise).

### Imperative shell — `web/src/components/BacklinksSection.tsx`

- Filter toggle (funnel icon) in the section header; hidden when
  `total_pages === 0`.
- Opening the panel triggers **load-all**: loop the existing
  `bl_offset`/`mergeGroups` pagination with `bl_limit=100` until
  `groups.length >= total_pages`. Spinner while loading; on fetch error
  show the error with a retry. Chips render only after the full set is
  loaded.
- Filter state is plain component state — resets on navigation
  (ephemeral by decision; URL/server persistence deliberately out of
  scope).

## Panel UI

- Active filters pinned at top as removable chips — includes visually
  distinct from excludes — plus a "Clear" action.
- Candidate chips below as `title (count)`, sorted count-desc.
- Click = include; shift-click = exclude; clicking an active chip clears
  it. A chip is in exactly one state (neutral/included/excluded), so
  exclude-wins conflicts cannot arise.
- While a filter is active the section header reads
  `Linked references (N of M)` where M is total source pages and N the
  visible count.
- Filters matching nothing render a "No matching references" message.
- "Show more" is hidden while the panel is open (everything is loaded).

## Testing

- **Unit (vitest)** on the core module: chip aggregation and counts,
  AND-includes, excludes, kind-merging, own-title exclusion, breadcrumb
  ref inheritance, N-of-M computation, empty-result case.
- **E2E (Playwright)**: one spec — a page whose backlinks span multiple
  tags (including a nested block whose parent carries the tag); open the
  panel, filter-for, filter-out (`click({ modifiers: ["Shift"] })`),
  assert item/group visibility and the header count; clear filters.

## Edge cases

- Zero backlinks → no filter button.
- Load-all mid-loop failure → error + retry; no partial chip panel.
- `total_pages` growing between paginated requests: loop until a request
  returns no new groups, not just until the initially-reported total.
