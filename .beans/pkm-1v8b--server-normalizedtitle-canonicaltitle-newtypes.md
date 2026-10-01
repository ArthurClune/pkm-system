---
# pkm-1v8b
title: Server NormalizedTitle / CanonicalTitle NewTypes
status: todo
type: task
priority: normal
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T07:44:52Z
parent: pkm-7uxw
blocked_by:
    - pkm-dapm
---

Introduce `NormalizedTitle` and `CanonicalTitle` (a subtype) on the server, so that pyrefly flags a raw title reaching a lookup. That raw-title lookup is the cause of every bug fixed by the title-lookup bug. The epic body defines the three title forms.

Server only: a `NewType` doesn't change the JSON schema, so nothing changes on the wire.

## Plan

- [ ] `NormalizedTitle = NewType("NormalizedTitle", str)` and `CanonicalTitle = NewType("CanonicalTitle", NormalizedTitle)` in `server/src/pkm/refs.py`; `normalize_title` (`:44`) and `canonicalize_title` (`:64`) return them
- [ ] `store.fetch_page(db, title: CanonicalTitle)` (`server/store.py:36`), and the same on the SQL helpers behind todos/changed (`server/routes_search.py:90,111`) and query (`server/query.py:108`)
- [ ] Rows read back from `pages.title` / `sidebar_entries.title` are `CanonicalTitle` at the row mapper
- [ ] `rename.rewrite_title_refs_map` (`rename.py:112-150`) takes a `normalize=` callback because callers key their maps by different forms; type the map keys and see whether the callback can go
- [ ] `title_migration.py:184,203`: rename `clean_pages`, which holds every page keyed by stored title (the lookup there is correct)
- [ ] `uv run pyrefly check` clean, with no `cast` added to silence a real raw-title path
