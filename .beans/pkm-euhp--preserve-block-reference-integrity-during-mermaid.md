---
# pkm-euhp
title: Preserve block-reference integrity during Mermaid conversion
status: completed
type: bug
priority: high
created_at: 2026-07-31T15:55:02Z
updated_at: 2026-07-31T15:55:02Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 9.

**References:** server/src/pkm/importer/rows.py:48-61; server/src/pkm/importer/migrate_mermaid_blocks.py:82-93; docs/architecture/backend.md:325-328

Mermaid conversion flattens descendant text and drops/deletes descendant rows and stable UIDs. Any external ((child-uid)) reference becomes permanently unresolved, contradicting the documented UID-preservation invariant.

**Direction:** Detect inbound references before conversion. Preserve referenced descendants, rewrite references only where semantics are valid, or refuse/report conversion. If a lossy mode remains, enumerate every affected UID.

- [x] Test referenced nested Mermaid descendants
- [x] Add dry-run reporting of affected UIDs and inbound references
- [x] Preserve or explicitly gate lossy metadata/UID removal

## Summary of Changes

Both conversion paths now detect, before flattening, whether any descendant
that would be dropped is still targeted by an inbound `((uid))` reference
from a block **outside** the subtree being flattened. If so, the whole
subtree is left as ordinary nested blocks instead — no descendant row, and
no uid, ever disappears while referenced.

- `server/src/pkm/importer/rows.py`: `to_rows()` now runs a one-time
  `_collect_block_ref_sources()` pass over the whole export (pages +
  orphan blocks) to map every `((uid))` target to its source uid(s).
  `walk()` checks this before honoring `convert_to_fence()`'s result; if
  any descendant is externally referenced, the fence is discarded and the
  block's children are walked normally instead. Preserved descendants are
  collected into the new `Rows.mermaid_preserved_refs` field
  (`(descendant_uid, external_source_uids)` pairs), which flows into
  `ImportReport.mermaid_preserved_refs` (`report.py`) and is rendered as a
  new "mermaid subtrees preserved (referenced descendants)" section
  (`report.py::render`), wired up in `run.py`.
- `server/src/pkm/importer/migrate_mermaid_blocks.py`: `find_candidates()`
  is replaced by `plan_migration()`, which returns a `Plan` (`candidates`:
  safe to flatten; `preserved`: left alone, with `Preserved(component_uid,
  descendant_uid, source_uids)` detail). `_all_block_ref_sources()` and
  `_subtree_uids()` provide the same outside-the-subtree check as rows.py,
  but against the live `blocks` table. `main()` prints the preserved list
  (`_print_preserved`) before any deletion in **both** `--dry-run` and a
  normal run, and only converts the safe `candidates`.
- `docs/architecture/backend.md`: qualified the "every existing
  `((block ref))` ... keeps resolving" invariant (~line 326) with a new
  paragraph explaining the mermaid exception and pointing at both
  `Rows.mermaid_preserved_refs` and `migrate_mermaid_blocks.py`'s
  `Plan.preserved`.

### Testing

TDD throughout: failing tests written first for each behavior, confirmed
RED, then implementation until GREEN.

- `server/tests/test_rows.py`: added
  `test_unreferenced_mermaid_subtree_reports_no_preserved_refs` and
  `test_externally_referenced_descendant_prevents_flattening` (new
  `MERMAID_REF_EXPORT` fixture with an external `((uid-refline2))`
  reference).
- `server/tests/test_migrate_mermaid_blocks.py`: extended the shared
  fixture with a second component block (`uid_ref_component`) whose
  descendant `uid_ref_line2` is externally referenced by `uid_citer`.
  Added `test_dry_run_reports_affected_uids_and_inbound_refs_for_preserved_descendants`
  and `test_migration_preserves_component_with_externally_referenced_descendant`.
  Adjusted two pre-existing FTS assertions (`test_fts_reflects_migration`)
  whose search terms ("flowchart", "detail") now also legitimately match
  the new fixture's untouched, preserved blocks — not a bug, just fixture
  interference; retargeted to unique substrings ("TB", "nested").
- `server/tests/test_report.py`: added
  `test_render_lists_mermaid_preserved_refs` and
  `test_render_mermaid_preserved_refs_none_by_default`.

RED confirmed for every new test before implementation (`AttributeError` /
`KeyError` / `TypeError` / wrong-value assertions as appropriate); GREEN
confirmed after.

### Verification

- `cd server && uv run pytest -q` — 974 passed, coverage 96.06% (>= 95%
  required).
- `cd server && uv run pyrefly check` — 0 errors (after widening
  `convert_candidates`'s parameter from `list[tuple[str, str]]` to
  `Sequence[tuple[str, str]]`, since `Plan.candidates` is a tuple).
- `cd server && uv run ruff check` — all checks passed.

### Self-review notes

- No overbuilding: block-ref detection is a straightforward two-function
  addition per module (collect sources, collect subtree uids), reusing
  existing `extract()`/`convert_to_fence()`/`is_mermaid_trigger()`
  machinery rather than inventing new parsing.
- Both modules independently implement the same "external reference"
  check because they operate on different data shapes (in-memory `Block`
  tree in `rows.py` vs. live sqlite rows in `migrate_mermaid_blocks.py`);
  no shared helper was extracted since `pkm.importer.mermaid` already
  exists precisely to avoid drift on the *fence-building* logic, and the
  reference-detection logic here is small enough per-module that a shared
  abstraction would need a lowest-common-denominator data shape (probably
  another `Protocol`), which felt like premature machinery for two ~15-line
  functions each.
- Considered rewriting/dropping only the individual internal self-refs
  among to-be-flattened descendants (finer-grained), but the bean's
  ambiguity resolution explicitly preferred "skip the flatten-and-drop for
  that subtree" as the mechanism, so implemented that rather than a
  partial-preservation scheme.
