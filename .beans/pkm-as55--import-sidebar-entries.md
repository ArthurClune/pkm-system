---
# pkm-as55
title: Import sidebar entries
status: completed
type: feature
priority: normal
created_at: 2026-07-09T18:54:26Z
updated_at: 2026-07-09T21:29:07Z
---

Sidebar entries need to be imported. Source: fetch from the API, or Arthur can just provide a list. Decide approach first, then implement.


## Sidebar entries (provided by Arthur, 2026-07-09)

- AWS
- AI
- Crypto
- Cyber Security
- Economics
- Education
- Environmentalism
- Exercise
- Internet Harm
- LLMs
- Management
- Mathematics
- Metacognition
- MacOS
- My Setup
- Politics
- Philosophy
- Raspberry Pi
- Research Computing
- Roam
- Software Development
- Work Notes

Notes: "Philosophy" appeared twice in the provided list (recorded once). "Al" in the original paste assumed to be "AI". No API fetch needed — import from this list.


## Summary of Changes

**Storage** (`server/src/pkm/schema.py`): added a `sidebar_entries(id, title UNIQUE, order_idx)` table. There is no migration runner in this project — DDL only ever runs against brand-new databases (fresh importer output, tests). To make existing/production databases pick up the new table automatically with no manual step, the table's DDL statement is `CREATE TABLE IF NOT EXISTS` and is re-executed on every connection open in `server/db.py::open_db()` (cheap no-op after the first time). This is a deliberate departure from the plain-`CREATE TABLE` convention used by the other tables, documented with a comment in both files.

**API** (`server/src/pkm/server/routes_sidebar.py`): `GET /api/sidebar` -> `{"entries": [{"id", "title"}, ...]}`, ordered by `order_idx`, auth-gated like other routes. Registered in `app.py`. Regenerated `web/src/api/openapi.json` and `web/src/api/types.d.ts` (`uv run python -m pkm.server.openapi_dump` + `pnpm gen-types`) since `test_openapi_sync.py` compares the full schema, not just changed models.

**Frontend**: `web/src/components/SidebarNav.tsx` (new, colocated test) fetches `/api/sidebar` and renders entries as plain `react-router-dom` `Link`s (`pagePath()` from `paths.ts`) styled as `.nav-link`, wired into the `.left-nav` in `App.tsx` below the Search button. Visiting a link creates/opens the page as normal (pages are not pre-created). Added `.nav-sidebar-entries` / `.nav-sidebar-error` CSS and `overflow-y: auto` on `.left-nav` so 22+ entries scroll sensibly, including on the <600px fixed/hamburger nav. Read-only per design; management UI is deferred to follow-up bean pkm-4wbu.

**Import script** (`server/src/pkm/importer/import_sidebar.py`, pure ordering logic factored into `server/src/pkm/importer/sidebar_rows.py`): `python -m pkm.importer.import_sidebar --data-dir DATA`. Idempotent — ensures the table exists, skips titles already present, inserts the rest in one short transaction, continuing `order_idx` from the current max. Opens the target db directly with `sqlite3.connect` (not `open_db`) to keep the transaction scope explicit, per the design's WAL-safety requirement.

**Tests**: `uv run pytest` — 200 passed (added `test_sidebar_rows.py`, `test_import_sidebar.py`, `test_sidebar_endpoint.py`, plus additions to `test_schema.py` and `test_server_scaffold.py` covering the legacy-db backfill). `pnpm vitest run` — 162 passed (added `SidebarNav.test.tsx`). `pnpm typecheck` clean. `pnpm build` succeeds.

**Live import** (approved by Arthur): tested first against a throwaway copy of `~/.config/pkm/data/pkm.sqlite3` taken via the SQLite backup API from a `mode=ro` connection — verified idempotency (second run: 0 inserted) and that page/block counts were unchanged. Then ran for real:

```
$ uv run python -m pkm.importer.import_sidebar --data-dir ~/.config/pkm/data
sidebar import: inserted 22, skipped 0 already-present (of 22 total)
```

Read-only verification against the live db afterward:

```
1|AWS|0
2|AI|1
3|Crypto|2
4|Cyber Security|3
5|Economics|4
6|Education|5
7|Environmentalism|6
8|Exercise|7
9|Internet Harm|8
10|LLMs|9
11|Management|10
12|Mathematics|11
13|Metacognition|12
14|MacOS|13
15|My Setup|14
16|Politics|15
17|Philosophy|16
18|Raspberry Pi|17
19|Research Computing|18
20|Roam|19
21|Software Development|20
22|Work Notes|21

pages=4314, blocks=52697  (unchanged from before the import)
```

Re-ran the import once more afterward to confirm idempotency against the live db: `inserted 0, skipped 22`. The running production server process was never restarted and has no `/api/sidebar` route until Arthur deploys this branch; only the SQLite file was touched, in WAL mode, via short transactions.

## Deferred

- Managing sidebar entries (add/remove/reorder) from the UI: tracked as pkm-4wbu.
