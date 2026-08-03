---
# pkm-krb7
title: Tidy the language in README and the architecture docs
status: completed
type: task
priority: normal
created_at: 2026-08-03T14:58:30Z
updated_at: 2026-08-03T15:16:30Z
---

Editorial pass over README.md and docs/architecture/*.md.

Scope:
- README: move the CLI/MCP reference out (it does not belong in a README); add a short embedded-assistant summary (details stay in deploy/README.md).
- docs/architecture: plainer language, short sentences and paragraphs, no bean IDs, without losing technical detail.
- overview.md: rename 'Load-bearing decisions' to 'Key decisions'.
- sync-and-offline.md: rewrite the replica-open-failure section.
- frontend.md: rewrite 'Views and navigation' and the mouse-only-heading passage.
- backend.md: rewrite 'Image descriptions' and 'Configuration and entrypoints'.
- Finally check the latest web/backend epics are covered where they changed the architecture.

## Summary of Changes

**New `docs/cli.md`.** The whole CLI/MCP reference moved out of README: login,
command reference, writing/reading behaviour, `pkm batch` command table, MCP
setup (Claude Code / `.mcp.json` / Claude Desktop), the eleven MCP tools, and
the one-time title-canonicalization operator procedure. README keeps a
15-line "Agent access" summary that links to it. Every backticked token from
the old README section is preserved in README + docs/cli.md (checked
mechanically).

**README** also gained an `## Assistant` section (Cmd/Ctrl+J, model choice,
server-side agent confined to the pkm verbs, reads auto-allowed / writes
confirmed, ephemeral conversations) plus a What-list bullet, with setup left
in `deploy/README.md`. The importer paragraph was rewritten into three short
paragraphs.

**docs/architecture: language.** All four docs rewritten for shorter
sentences and paragraphs, fewer em-dash chains, and no "load-bearing /
deliberately / exactly" filler where it carried no information. Every bean ID
removed (43 in backend.md, 23 in frontend.md, 9 in sync-and-offline.md) with
the lesson each one carried kept as prose. No technical claim dropped:
verified by diffing the set of backticked identifiers old vs new.

- `overview.md`: "Load-bearing decisions" -> "Key decisions" (no inbound
  anchor links existed). Otherwise untouched, as requested.
- `sync-and-offline.md`: the replica-open-failure section rewritten as
  "Opening the replica can fail, and that is a storage problem, not a sync
  problem", split into three named failures (open throws / pool too small to
  write / either hits an enqueue) plus a short diagnostic note; the hub
  fan-out and shim-return-type walls of text broken up; rebootstrap triggers
  given their own subsection.
- `frontend.md`: "Views and navigation" rewritten as a route table plus four
  subsections (route metadata, navigation chrome, /files, journal day
  references). The mouse-only-heading trap rewritten as "A heading with an
  `onClick` cannot be reached from the keyboard" with three named sub-points
  (inheriting the type takes three declarations; both triggers need
  display:block + width:100%; .page-title-edit must stay content-named).
  Radius tokens became a table.
- `backend.md`: "Image descriptions" rewritten with a module table and
  What-gets-described / queue / configuration / search-seam subsections.
  "Configuration and entrypoints" rewritten as a config-key table (verified
  against `server/config.py`, including the paths-relative-to-config.json
  rule). Export/backup, CLI/MCP and title-integrity sections split into
  subsections instead of long bullets.

**Epic coverage check** (pkm-ulae, pkm-6phf, pkm-mk87 were already
documented). Three gaps found and filled:

- Batched sync hydration (pkm-ldqx): new bullet in sync-and-offline.md's
  changes-feed section — `chunk_ids` (500/statement) + `hydrate_in_order`,
  both pure, response shapes unchanged. `sync_core.py`'s row in backend.md's
  module table now mentions hydration ordering.
- Describe dedup (pkm-1wv1): the `_active` set of queued/mid-attempt shas,
  and `_process`'s re-read, documented in the new Image descriptions queue
  subsection.
- Batch envelope validation (pkm-4w23): documented in backend.md's planner
  section — `validate_batch` parses the whole envelope against a
  discriminated-union schema before any page fetch or page/asset creation.
- Also mentioned PdfViewer's render-time generation guard (pkm-qs7y) beside
  the /files pagination guard, since it is the same idea applied to a
  child-before-parent effect race.

`deploy/README.md`: dropped the two bean IDs from its prose for consistency.

Verification: docs-only, so no test run (nothing in server/tests, web/src,
web/e2e or web/tooling reads these files). All internal markdown links and
anchors machine-checked across README, docs/cli.md, docs/architecture/* and
deploy/README.md.
