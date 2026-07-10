---
# pkm-4wbu
title: Manage sidebar entries from the UI (add/remove/reorder)
status: completed
type: feature
priority: normal
created_at: 2026-07-09T21:28:48Z
updated_at: 2026-07-09T23:11:00Z
---

Follow-up to pkm-as55: the left-nav sidebar entries list (GET /api/sidebar) is read-only. Add UI + API (POST/PATCH/DELETE) to add, remove, and reorder entries, backed by the sidebar_entries table (server/src/pkm/schema.py).

## Summary of Changes

**API** (`server/src/pkm/server/routes_sidebar.py`): added three routes alongside the existing `GET /api/sidebar`, all auth-gated the same way.
- `POST /api/sidebar` — body `{title}`, appends at the end (`order_idx` = current max + 1), 422 on a blank/whitespace-only title, 409 on an exact-duplicate title, returns `{id, title}`.
- `DELETE /api/sidebar/{entry_id}` — 404 if the id doesn't exist, else `{ok: true}`.
- `PUT /api/sidebar` — body `{order: [id, ...]}`, the simplest atomic reorder: the client sends the *full* new id ordering and the server rewrites every `order_idx` in one `executemany`. Rejected with 400 unless `order` is exactly a permutation of the existing ids (no partial lists, no unknown/duplicate ids) — this validation is the one non-trivial piece of logic and is pure, in `server/src/pkm/importer/sidebar_rows.py::reorder_is_valid`, alongside a new `next_order_idx` helper used by the POST route. Both have dedicated unit tests in `test_sidebar_rows.py`.
- Regenerated `web/src/api/openapi.json` + `web/src/api/types.d.ts` so `test_openapi_sync.py` stays green.

**UI** (`web/src/components/SidebarNav.tsx`): the sidebar is unchanged in normal view except for a small "Edit" text-link at the bottom (styled like the existing nav links, muted color). Clicking it reveals, per entry, ↑/↓/× buttons (disabled at the top/bottom of the list) and an "Add page…" input + Add button below the list. All three actions call the API then refetch `GET /api/sidebar` (refetch chosen over optimistic updates, per the task's guidance — the list is short and server-assigned ordering makes refetch simple and always-correct). A duplicate-title POST surfaces "That entry already exists." inline near the add form; other failures show a generic "Couldn't add entry." Reordering computes the full new id list client-side (swap with neighbor) and sends it via the PUT route. New CSS in `web/src/styles.css` (`.nav-sidebar-edit-toggle`, `.nav-sidebar-entry*`, `.nav-sidebar-add`) uses only existing `--color-*` custom properties, so dark mode needs no separate rules.

**Tests**: server — `test_sidebar_rows.py` (+6 pure-function cases) and `test_sidebar_endpoint.py` (+15 cases: add/duplicate/blank/auth, delete/404/auth, reorder/partial/unknown-id/auth) — `uv run pytest`: 224 passed. Web — `SidebarNav.test.tsx` (+6 cases: controls hidden until edit mode, add posts+refreshes, remove deletes+refreshes, reorder posts the swapped id list+refreshes, up/down disabled at the boundaries) — `pnpm vitest run`: 225 passed across 33 files; `pnpm typecheck` and `pnpm build` both clean.

No drag-and-drop was added (that's pkm-jg1p/pkm-auvy, in flight elsewhere) — reordering is buttons only.

## Deferred / not done
- No optimistic UI updates (refetch only, per the simpler option offered in the task).
- No case-insensitive or trimmed-server-side duplicate detection beyond an exact string match after trimming the new title (an entry differing only in case or surrounding whitespace from an existing one would still be accepted as distinct) — not asked for, flagging in case it matters for the live data set.
