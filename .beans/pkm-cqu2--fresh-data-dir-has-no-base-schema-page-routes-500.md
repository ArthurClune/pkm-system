---
# pkm-cqu2
title: 'Fresh data dir has no base schema: page routes 500 with ''no such table: pages'''
status: todo
type: bug
created_at: 2026-07-10T13:02:39Z
updated_at: 2026-07-10T13:02:39Z
---

Following the README setup path (pkm.server.setup then pkm.server.run with a brand-new data dir, no Roam import) produces a broken app: every page route 500s with sqlite3.OperationalError: no such table: pages (seen from routes_pages.get_journal -> store.fetch_page).

Root cause: create_app() calls init_db() (added in pkm-2939), but init_db only sets WAL mode and runs incremental IF-NOT-EXISTS migrations -- the base schema (pages, blocks, etc.) is only ever created by the importer's fresh-database build. So a new install without an import has no tables.

Fix direction: init_db (or setup) should create the full base schema idempotently so an empty PKM works out of the box; the importer's schema-creation code is presumably the source of truth to share/reuse.

Found 2026-07-10 while verifying pkm-2gn2 against a scratch data dir.
