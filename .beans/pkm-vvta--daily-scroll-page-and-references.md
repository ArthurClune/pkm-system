---
# pkm-vvta
title: daily scroll page and references
status: completed
type: feature
priority: normal
created_at: 2026-07-27T17:44:49Z
updated_at: 2026-07-27T18:27:46Z
---

We need to surface links to a daily note page on the scroll view.dd

Use case: On a different page, user enters "Remind me on [[July 28th, 2026]] to check this"

It should show on the daily scroll page. Currently it's only visible when clicking through


## Summary of Changes

Implemented per-day linked references on the journal (daily scroll) view, reusing the existing page-view backlinks component/filtering (pkm-m4an) rather than a new renderer.

**Client (web/)**
- New `web/src/components/JournalDayReferences.tsx`: lazily fetches `/api/page/{title}?bl_limit=5` for a day (a small preview limit -- also keeps this request's URL distinct from a plain parent-page read of the same title, so the two don't collide when a page is open in both the journal and elsewhere at once). Renders nothing when the day has zero references; otherwise renders the reused `BacklinksSection`, merging the day's own `block_ref_texts` into the ambient `BlockRefContext`.
- `Journal.tsx` renders `<JournalDayReferences title={day.title} />` under each day's outline. The fetch runs after the day itself has rendered, so it never blocks the journal's initial paint; each day fetches independently.
- Updated `Journal.test.tsx` (one pre-existing assertion had to switch from `toHaveBeenLastCalledWith` to `toHaveBeenCalledWith`, since a day's own reference fetch can now legitimately land after a journal-page fetch) and added a dedicated test for the show/hide behavior. Added `JournalDayReferences.test.tsx` (4 cases: empty, populated, day-local block-ref resolution, fetch failure).

**Server (server/)**
- Included the journal-window change (not deferred): `/api/journal` (routes_pages.py) now also treats a daily page as "non-empty" (i.e. visible in the scroll) if another page has an inbound `[[link]]` to it, even with zero blocks of its own -- so "Remind me on [[July 28th, 2026]]" surfaces under that day even before anyone writes to the day directly. This was a small, contained addition (one extra SQL query unioned into the existing non-empty-day set) so it shipped rather than being deferred. Mirrored in the offline shim (`web/src/replica/localApi/journal.ts`) for shim parity, with dedup-by-title since the TS side uses a plain array rather than Python's set.
- Added server tests in `test_journal_assets.py` (referenced-empty-day appears; unreferenced-empty-day stays hidden) and TS tests in `router.test.ts` (same two cases, plus a "referenced AND non-empty is not duplicated" regression test for the TS array-dedup fix).
- Extended the shim-parity fixture (`shim_parity_dump.py` + regenerated `shared/fixtures/shim_parity.json`) with a new case (`journal_referenced_empty_day`) covering this behavior end-to-end between the two engines.
- Regenerated `web/src/api/openapi.json` + `types.d.ts` (the `get_journal` docstring changed).

**E2E**
- New `web/e2e/journal-references.spec.ts`: writes a `[[today's title]]` reference on a separate, uniquely-named page (today's own daily note is never touched, so it can't collide with edit.spec.ts's "today starts empty" assumption), then asserts the reference appears under the correct day section on the journal scroll. Reads today's title off the already-rendered journal DOM (not a side-channel API call) and includes a short settle wait before editing -- both defend against the same pre-existing pkm-c9hp-style client/replica-sync race that affects `backlink-filter.spec.ts` (confirmed via a minimal repro during debugging: referencing a page whose local replica hasn't caught up yet can trip a "legacy-rejected" repair that discards the in-flight edit). This measurably reduced but did not eliminate the flake's already-low failure rate for this new spec; per the task brief's guidance for the known flake, no attempt was made to fix the underlying race itself (pkm-c9hp is being handled separately).

**Verification**: `server && uv run pytest -q` (743 passed, 95.72% coverage), `uv run pyrefly check`, `uv run ruff check`; `web && pnpm verify` (typecheck + lint + fcis + coverage + build + full Playwright e2e, 36/36 e2e passed on a clean rerun) all green.

**Design defaults followed**: reused BacklinksSection/pkm-m4an filtering as directed; per-day lazy fetch that doesn't block journal render; empty days render no section; extended the existing per-page endpoint rather than adding a new one (consistent with the prior "backlinks-only endpoint deferred" decision noted in team memory); journal-window change included (not deferred) since it stayed contained to one SQL addition mirrored in both engines.
