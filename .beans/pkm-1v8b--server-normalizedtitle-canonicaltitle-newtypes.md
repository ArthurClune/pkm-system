---
# pkm-1v8b
title: Server NormalizedTitle / CanonicalTitle NewTypes
status: in-progress
type: task
priority: normal
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T11:38:55Z
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

## Summary of changes

`NormalizedTitle`/`CanonicalTitle` NewTypes added in `refs.py`; `normalize_title`/`canonicalize_title` mint them. `store.fetch_page` and every rename/merge/retitle/delete helper in `store.py` now take `CanonicalTitle`; `index_ref` takes `NormalizedTitle`. `sync_meta.read_title`/`title_reader` and `query_exec`'s canonicaliser return `CanonicalTitle`. `pkm/title_migration.py`'s `InventoryPage.title`/`InventorySidebar.title`/`TitleMigrationBlocker.title`/`TitleMigrationGroup.canonical_title`/`TitleMigrationPlan.replacements` are `CanonicalTitle`-typed (row-mapper boundary); `clean_pages` renamed `pages_by_stored_title`. `routes_pages.py` gained a `_daily_title()` helper casting `title_for_date()` (a fixed, always-canonical format) at its `fetch_page`/`delete_page_rows` call sites. `rewrite_title_refs_map`'s `normalize=` callback stays: `store.py`/`ops_core.py` use the identity default over `CanonicalTitle`-keyed maps (dict literals widen to `Mapping[str, str]` at the call boundary, so no cast needed there), while `importer/titles.py` passes `normalize_title` over a map keyed by mixed raw/`NormalizedTitle` spellings -- two genuinely different key forms, so the callback cannot be dropped. No casts were added to silence a real raw-title bug; every cast is at a mint point (a canonicaliser's own output, a `pages.title`/`sidebar_entries.title` row read, a fixed-format daily title, or a test/perf fixture). `pyrefly check`: 0 errors, 11 suppressed, 7 warnings -- identical to `main`. `ruff check`: clean. `pytest`: 2258 passed, 97.54% coverage. `docs/architecture/backend.md` § Title integrity gained the vocabulary.
