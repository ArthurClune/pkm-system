# Auto-delete empty daily note pages on Journal load (pkm-c3kz)

**Date:** 2026-07-12
**Status:** Approved

## Problem

Empty daily-note pages accumulate. Two sources: navigating to a past daily
page auto-creates it (`GET /api/page/{title}` creates on 404 when
`date_for_title` parses), and today's page is auto-created by the journal
endpoint whether or not anything gets written. Pages that had content can
also become empty later when their blocks are moved elsewhere. These empty
pages clutter the page list and search.

## Behavior

When the Journal (daily notes) view mounts, the web client fires a
fire-and-forget `POST /api/journal/cleanup`. The server checks the 7 daily
pages before today — yesterday back through 7 days ago, titles via
`title_for_date`. Today is excluded: it is auto-created for composing. Any
candidate page that exists and is *completely empty* is deleted.

The check is stateless. Every load re-checks all 7 days, so a page emptied
since the last check (e.g. by block moves) is caught on the next load. There
is no user-visible UX: no buttons, no prompts, and no UI change — the Journal
renders an empty-but-existing page and a non-existent day identically.

Response body: `{"deleted": ["July 9th, 2026", ...]}` — consumed by tests
and logs only.

### Definition of "completely empty"

A page is empty when it has zero blocks, OR every block's text is empty or
whitespace-only.

Safety check: if any of those blank blocks is referenced via `((uid))` from
a block on another page, the page is spared. Lookup is a
`LIKE '%((uid))%'` scan per candidate blank block, excluding blocks on the
candidate page itself; candidates are at most a handful of blocks across 7
pages, so cost is negligible.

## Server design

FCIS split:

- **Functional Core** (`server/src/pkm/server/daily.py`):
  - `past_week_dates(today: date) -> list[date]` — the 7 dates before
    `today`.
  - `is_page_empty(block_texts: Sequence[str]) -> bool` — true when all
    texts are blank (also true for the empty sequence).
- **Imperative Shell** (`server/src/pkm/server/routes_pages.py`):
  - New route `POST /api/journal/cleanup`. For each candidate title:
    fetch page; if it exists, fetch its blocks; run the core emptiness
    check; run the `((uid))`-referenced check; delete if clear.
  - Deletion reuses the existing `DELETE /api/page/{title}` logic. The four
    statements (delete blocks explicitly so the `blocks_fts_ad` trigger
    fires, delete page, delete sidebar entry, commit) move into a shared
    `delete_page(db, page)` helper in `server/src/pkm/server/store.py`,
    used by both routes.
  - Same auth as the other API routes.

`date.today()` server-side matches the existing journal endpoint's
convention.

## Web design

`web/src/views/Journal.tsx`: on mount, one
`apiFetch("/api/journal/cleanup", { method: "POST" }).catch(() => {})`
fired in parallel with the existing first `loadMore()`. Fire-and-forget;
failures are silent (next load retries).

## Concurrency and staleness

- **Mount race:** the journal GET may return `exists: true` for a page the
  cleanup deletes a moment later. Harmless — rendering is identical.
- **Stale open view:** deletion does not broadcast a websocket batch and
  `resyncSeq` only bumps on reconnect, so a mounted Journal keeps stale
  `exists` flags. Also harmless: if the user types into a day whose page
  row was deleted, block-create ops carry `page_title` and the apply path
  calls `get_or_create_page`, transparently recreating the page.
- **Idempotence:** a second cleanup call finds nothing and returns
  `{"deleted": []}`.

## Testing

Server (`server/tests/`):
- Deletes a zero-block past daily page.
- Deletes a past daily page whose blocks are all whitespace-only.
- Skips today's page even when empty.
- Skips pages with any non-blank block.
- Skips a page whose blank block is `((referenced))` from another page.
- Deleted blocks are removed from FTS.
- Second call returns `{"deleted": []}`.
- Requires auth.
- Core unit tests for `past_week_dates` and `is_page_empty`.

Web (`web/src/views/Journal.test.tsx`):
- Journal mount fires `POST /api/journal/cleanup`.
- Existing Journal tests still pass.

## Out of scope / follow-ups

- Hiding or collapsing non-existent days in the Journal (pkm-zws4, draft).
- Cleaning up empty daily pages older than 7 days.
- Cleaning up empty non-daily pages.
