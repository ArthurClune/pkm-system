---
# pkm-g1ep
title: 'Clickable Local copy:: links served from the readdle pkm folder'
status: in-progress
type: feature
priority: normal
created_at: 2026-09-21T12:47:10Z
updated_at: 2026-09-21T13:53:19Z
---

Serve files under a configured local_docs_root via GET /api/local/{path}; rewrite Local copy:: values to markdown links; inline PDF viewer for /api/local/*.pdf; 503 for iCloud-evicted files; pkm local check; one-off scratchpad migration script (not committed). Spec: docs/superpowers/specs/2026-09-21-local-docs-links-design.md



## Progress

- [x] Task 1: `local_docs_root` config key (`server/src/pkm/server/config.py`)
- [x] Task 2: `local_docs.py` core — path containment, disposition, link shapes
- [x] Task 3: `GET /api/local/{path}` serves files under `local_docs_root`
- [x] Task 4: `GET /api/local/check` classifies every local link against disk
- [x] Task 5: shared eviction decision between the file route and check
- [x] Task 6: `pkm local check` CLI verb (missing/evicted link report)
- [x] Task 7: inline PDF viewer for `/api/local/*.pdf`, evicted-file note on 503, e2e click-through test
- [x] Task 8: architecture docs, `pkm` skill, this bean
- [ ] Task 9: operator migration — rewrite existing `Local copy::` values to `/api/local/` markdown links (one-off scratchpad script, not committed; not yet run in prod)

## Summary of Changes

- Routes (`routes_local.py`): `GET /api/local/check` — every `/api/local/`
  href found in block text, classified `ok`/`missing`/`evicted`/`invalid`
  against disk, `enabled: false` when unconfigured. `GET /api/local/{path}`
  — serves one file under `local_docs_root`, inline disposition for
  PDF/image extensions and attachment otherwise, 404 for anything outside
  the root or missing, 503 + `Retry-After` for an iCloud-evicted `.icloud`
  stub (after a best-effort `brctl download`).
- Core (`local_docs.py`): `resolve_relative` + `is_within` containment,
  `extract_local_hrefs`, `disposition_for`, `media_type_for`, `local_href`.
- CLI: `pkm local check [--json]`, exit `0` clean / `1` problems found / `2`
  local files not configured.
- Frontend: `InlineSegments.isPdfHref` now also matches `/api/local/*.pdf`
  (previously only `/assets/*.pdf`); `pdfViewerCore.failureNote` shows
  "Not downloaded on the host." for a 503 instead of the generic PDF-render
  failure note.
- Docs updated: `docs/architecture/backend.md` (module map, HTTP API
  reference, config table, new "Local documents" section),
  `docs/architecture/frontend.md` (the `isPdfHref` two-prefix rule and the
  503 failure note), `docs/architecture/sync-and-offline.md` (`/api/local/*`
  is online-only and not service-worker-cached), `docs/architecture/cli-and-mcp.md`
  (`pkm local check` has no MCP counterpart, with its exit codes),
  `.claude/skills/pkm/SKILL.md` (`pkm local check` read verb + a "Local
  files" note on the `Local copy::` link shape).

Status left `in-progress`: Task 9 (the operator migration) has not run yet.
