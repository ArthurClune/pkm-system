---
# pkm-1v8b
title: Server NormalizedTitle / CanonicalTitle NewTypes
status: completed
type: task
priority: normal
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T12:15:43Z
parent: pkm-7uxw
blocked_by:
    - pkm-dapm
---

Introduce `NormalizedTitle` and `CanonicalTitle` (a subtype) on the server, so that pyrefly flags a raw title reaching a lookup. That raw-title lookup is the cause of every bug fixed by the title-lookup bug. The epic body defines the three title forms.

Server only: a `NewType` doesn't change the JSON schema, so nothing changes on the wire.

## Plan

- [x] `NormalizedTitle = NewType("NormalizedTitle", str)` and `CanonicalTitle = NewType("CanonicalTitle", NormalizedTitle)` in `server/src/pkm/refs.py`; `normalize_title` (`:44`) and `canonicalize_title` (`:64`) return them
- [x] `store.fetch_page(db, title: CanonicalTitle)` (`server/store.py:36`), and the same on the SQL helpers behind todos/changed (`server/routes_search.py:90,111`) and query (`server/query.py:108`)
- [x] Rows read back from `pages.title` / `sidebar_entries.title` are `CanonicalTitle` at the row mapper
- [x] `rename.rewrite_title_refs_map` (`rename.py:112-150`) takes a `normalize=` callback because callers key their maps by different forms; type the map keys and see whether the callback can go
- [x] `title_migration.py:184,203`: rename `clean_pages`, which holds every page keyed by stored title (the lookup there is correct)
- [x] `uv run pyrefly check` clean, with no `cast` added to silence a real raw-title path

## Summary of Changes

`NormalizedTitle`/`CanonicalTitle` NewTypes added in `refs.py`; `normalize_title`/`canonicalize_title` mint them. `store.fetch_page` and every rename/merge/retitle/delete helper in `store.py` now take `CanonicalTitle`; `index_ref` takes `NormalizedTitle`. `sync_meta.read_title`/`title_reader` and `query_exec`'s canonicaliser return `CanonicalTitle`. `pkm/title_migration.py`'s `InventoryPage.title`/`InventorySidebar.title`/`TitleMigrationBlocker.title`/`TitleMigrationGroup.canonical_title`/`TitleMigrationPlan.replacements` are `CanonicalTitle`-typed (row-mapper boundary); `clean_pages` renamed `pages_by_stored_title`. `routes_pages.py` gained a `_daily_title()` helper casting `title_for_date()` (a fixed, always-canonical format) at its `fetch_page`/`delete_page_rows` call sites. `rewrite_title_refs_map`'s `normalize=` callback stays: `store.py`/`ops_core.py` use the identity default over `CanonicalTitle`-keyed maps (dict literals widen to `Mapping[str, str]` at the call boundary, so no cast needed there), while `importer/titles.py` passes `normalize_title` over a map keyed by mixed raw/`NormalizedTitle` spellings -- two genuinely different key forms, so the callback cannot be dropped. No casts were added to silence a real raw-title bug; every cast is at a mint point (a canonicaliser's own output, a `pages.title`/`sidebar_entries.title` row read, a fixed-format daily title, or a test/perf fixture). `pyrefly check`: 0 errors, 11 suppressed, 7 warnings -- identical to `main`. `ruff check`: clean. `pytest`: 2258 passed, 97.54% coverage. `docs/architecture/backend.md` § Title integrity gained the vocabulary.

### Review fixes (round 2)

A review found the NewTypes only guarded `store.py`'s helper surface; `routes_search.py` (todos/changed), `query.py`/`query_exec.py`, and `routes_sidebar.py` still bound raw titles with no pyrefly error. Fixed:

- `routes_search.py`: a `_page_filter(title: CanonicalTitle) -> tuple[str, CanonicalTitle]` helper is now the one way `todos`/`changed` add their `p.title = ?` predicate.
- `query.py`: `CanonicalQueryNode = NewType("CanonicalQueryNode", QueryNode)`, minted only by `query_exec.parse_canonical_query`. `plan_sql`'s public signature now takes `CanonicalQueryNode`; the old recursive body moved to a private `_plan_sql(node: QueryNode, ...)`.
- `routes_sidebar.py`/`store.py`: added `store.insert_sidebar_entry(db, title: CanonicalTitle, order_idx) -> int`, the typed INSERT choke point alongside `retitle_sidebar_entry`/`delete_page_rows`'s own `sidebar_entries` writes.
- `refs.canonicalize_title` now returns `NormalizedTitle`, not `CanonicalTitle` -- it takes `plain_space` as a caller-supplied bool, not the live DB flag, so its result was only "the" canonical spelling when the caller happened to pass that flag's value. `sync_meta.title_reader` is now the sole general `CanonicalTitle` mint; `store.get_or_create_page` and `ops_apply._hint_page_exists` now call `sync_meta.read_title` instead of canonicalizing locally (same single flag read, no new query). Added `refs.target_canonical_title(title) -> CanonicalTitle`, the one deliberate flag-bypassing mint the title migration (`pkm/title_migration.py`, `server/title_migration.py`) uses to plan/apply against the post-activation state.
- `ops_apply._page_title`/`_require_page_title` now return `CanonicalTitle | None`/`CanonicalTitle` (a genuine `pages.title` row read).
- `docs/architecture/backend.md` § Title integrity rewritten to name every mint point and guarded surface precisely, including the two things pyrefly still can't catch: an `Any`-typed value and a raw SQL statement that bypasses a typed helper entirely.

Verified via the reviewer's mutation probe (`mutate.py`, adapted for the restructured code, plus an added M11 testing the sidebar bypass case): M1-M10 all now **CAUGHT**; M7 (`Any`-typed title) stays **silent** as documented; M11 (raw SQL bypassing `insert_sidebar_entry`) is also **silent** -- an inherent limit of a typed-helper approach, not a regression, and called out in the docs. `pyrefly check`: 0 errors, 11 suppressed, 7 warnings -- still identical to `main`. `ruff check`: clean. `pytest`: 2258 passed, 97.54% coverage. No new `sync_meta` read or other query added (perf statement counts unchanged). No `# pyrefly: ignore`/`cast()` added.

### After the Opus review

An Opus reviewer put each pkm-dapm bug class back, one at a time, and ran
pyrefly. The first pass caught only the paths through `store.py`. The fix
commit closes the other three:

- the todos and changed page filters, through a typed `_page_filter`;
- query planning, where `plan_sql` now takes a `CanonicalQueryNode` that only
  `parse_canonical_query` mints;
- sidebar add, through `store.insert_sidebar_entry`.

`canonicalize_title` now returns `NormalizedTitle`, since it doesn't know the
live flag. `sync_meta.read_title` / `title_reader` is the only general
`CanonicalTitle` mint. `refs.target_canonical_title` is the one documented
exception, used only by the title migration.

The probe now catches all 10 mutations. Two cases remain that static typing
can't catch: values typed `Any`, and raw SQL that bypasses a typed helper.
`backend.md` § Title integrity names both.

Final checks: pytest 2258 passed. pyrefly 0 errors, with suppressions and
warnings unchanged from main. ruff clean. `perf/check.sh` backend: no changes
against the baseline. `openapi.json` is unchanged; this work is server only.
