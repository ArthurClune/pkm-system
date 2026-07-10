---
# pkm-cydp
title: Convert Roam mermaid component blocks to fenced blocks
status: completed
type: task
priority: normal
created_at: 2026-07-10T18:27:56Z
updated_at: 2026-07-10T18:32:53Z
---

Roam exports represent mermaid diagrams as a component block with text {{[[mermaid]]}} whose child blocks (depth-first outline) hold the diagram source lines. The importer currently imports these verbatim, so diagrams never render (web expects a single block containing a ```mermaid fenced code block). This work adds: (1) pure conversion logic detecting such component blocks and building the fenced text from their descendant subtree, (2) importer wiring so import_export.py (or parse_export.py/rows.py) applies the conversion at import time, consuming the children into one block, and (3) an idempotent one-off migration script (modelled on import_sidebar.py) to fix already-imported databases: rewrite the block text, delete descendant blocks, and delete refs rows pointing at the mermaid page, all in one transaction, with dry-run support. Known live-DB targets: 8 such blocks across pages Columnar Database, SAP Database Concepts, SAP Technical Foundations, Tailscale (childless mention possibly on page Roam should NOT be touched).

Checklist:
- [x] Pure conversion logic (Functional Core) + unit tests (nested subgraphs, ordering, both trigger spellings, childless -> no conversion)
- [x] Importer wiring (parse_export.py/rows.py) applies conversion at import time; ref-extraction runs on final fenced text; importer tests added
- [x] One-off migration script (dry-run + real run), idempotent, single transaction, refs cleanup, FK cascade for descendants' refs
- [x] Migration script tests incl. FTS search verification (source line still found on fenced parent, deleted children gone)
- [x] pytest / pyrefly / ruff all pass
- [x] Bean updated with Summary of Changes and exact migration invocation

## Summary of Changes

- `server/src/pkm/importer/mermaid.py` (new, Functional Core): shared
  detection + flattening logic. `is_mermaid_trigger(text)` matches
  `{{[[mermaid]]}}` or `{{mermaid}}` (surrounding whitespace allowed).
  `convert_to_fence(text, children)` returns the fenced
  `` ```mermaid\n...\n``` `` text (descendant subtree flattened
  depth-first, two-space indent per nesting level relative to the
  component block) or `None` if the block isn't a mermaid component with
  at least one child. Unit tests in `server/tests/test_mermaid.py`
  (nested subgraphs, ordering, both trigger spellings, childless
  mention -> no conversion, non-trigger text with children -> no
  conversion).
- `server/src/pkm/importer/rows.py`: `to_rows()`'s tree walk now calls
  `convert_to_fence` on each block before transform/ref-extraction; a
  match replaces the block's own text with the fence and its children
  are not walked/emitted as separate block rows (ref-extraction runs on
  the final fenced text, so it never links to a `[[mermaid]]` page).
  Tests added to `server/tests/test_rows.py`.
- `server/src/pkm/importer/migrate_mermaid_blocks.py` (new, Imperative
  Shell): one-off migration for already-imported databases. Finds every
  block matching the trigger with children, and in one transaction:
  rewrites its text to the fence, deletes its direct children (schema.py's
  `ON DELETE CASCADE` on `blocks.parent_uid` recursively removes the rest
  of the subtree and each removed block's own `refs` rows), and deletes
  the top block's own `refs` row(s) pointing at the `mermaid` page (plain
  UPDATE/DELETE statements only, so `blocks_fts` stays in sync via
  schema.py's existing triggers). Sets `PRAGMA foreign_keys=ON` itself.
  Idempotent: converted blocks no longer match the trigger text, so a
  second run converts nothing. `--dry-run` reports candidates without
  writing. Tests in `server/tests/test_migrate_mermaid_blocks.py`,
  including an FTS check (source line still found via the fenced parent,
  gone from search once children are deleted).
- Not run against any real/live database from this worktree; verified
  against temp databases built via `pkm.server.db.init_db` only.

Migration invocation (against the real data dir's `pkm.sqlite3`, run by
the orchestrator, not from this worktree):

```
# preview first
uv run python -m pkm.importer.migrate_mermaid_blocks --db /path/to/data/pkm.sqlite3 --dry-run

# then apply
uv run python -m pkm.importer.migrate_mermaid_blocks --db /path/to/data/pkm.sqlite3
```

Verification: `uv run pytest -q` (307 passed), `uv run pyrefly check` (0
errors), `uv run ruff check` (all checks passed) -- all run from `server/`.
