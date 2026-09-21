---
# pkm-g1ep
title: 'Clickable Local copy:: links served from the readdle pkm folder'
status: completed
type: feature
priority: normal
created_at: 2026-09-21T12:47:10Z
updated_at: 2026-09-21T14:48:52Z
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
- [x] Task 9: operator migration — rewrite existing `Local copy::` values to `/api/local/` markdown links (one-off scratchpad script, not committed; run in prod 2026-09-21, 563 rewrites)

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

Task 9 ran on 2026-09-21; see Deployment below.


## Deployment
Merged to main at e763e2b (--no-ff), pushed, deployed via deploy/update.sh to cb3366c on 2026-09-21. Added local_docs_root to prod config.json. Renamed the two files with '%' in their names first. Migration (scratchpad script, not committed) rewrote 563 blocks via pkm batch; `pkm local check` reports 563 ok, 0 problems.


Post-deploy: first fetches hung in open() until macOS showed the Files and Folders → iCloud Drive consent prompt for /opt/homebrew/bin/uv (the launchd program) at the GUI session; Arthur accepted it, local_docs_root was re-enabled and the service restarted. Verified 2026-09-21: 1.2 MB and 55 MB PDFs stream in full in <0.1 s; `pkm local check` 563 ok. Route stays behind session auth; traversal attempts 404.
