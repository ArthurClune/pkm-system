# PKM Importer Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give malformed imports friendly diagnostics, refuse non-tree exports before filesystem work, make Mermaid preservation globally safe, and correct importer counts/reporting/cleanup claims.

**Architecture:** EDN parsing, structure validation, Mermaid planning, and row derivation remain functional cores. `run.py` and the SQLite Mermaid migration remain thin shells. Parsing and structural preflight precede linked-file indexing and output/temp creation; title-integrity canonicalization already present in `run.py` remains after database build and before publication.

**Tech Stack:** Python 3.12, pytest, SQLite, uv, pyrefly, ruff.

## Global Constraints

- Start from the completed title-integrity lane; preserve its pre-publication title audit/apply step in `run.py`.
- Keep `\/` invalid; do not add implicit Logseq/JSON compatibility.
- Catch only `EdnError` for malformed EDN and `ImportStructureError` for structural refusal.
- Structural preflight finishes before linked-file indexing, output-directory creation, SQLite connection, or report temp creation.
- Every candidate Mermaid ancestor containing a protected nested component is preserved.
- Report rows deduplicate by descendant UID and union/sort source UIDs.
- Earlier database-build/asset-copy failures may leave self-healing `pkm.sqlite3.tmp`; report-phase failures remove remaining named temp files.
- New runtime modules declare FCIS pattern.

---

### Task 1: Structured EDN errors

**Files:**
- Modify: `server/src/pkm/edn.py`
- Modify: `server/tests/test_edn.py`
- Modify: `.beans/pkm-5h2k--importer-cli-friendly-error-for-malformed-edn-expo.md`

**Interface:**
```python
class EdnError(ValueError):
    detail: str
    offset: int
    def __init__(self, detail: str, offset: int) -> None: ...
```
Offsets are zero-based Python character positions.

- [ ] **Step 1: Mark `pkm-5h2k` and `pkm-x1ig` in progress**

  ```bash
  beans update --json pkm-5h2k -s in-progress
  beans update --json pkm-x1ig -s in-progress
  ```

- [ ] **Step 2: Write structured RED tests**

  Parameterize EOF, unterminated map/sequence/string, odd map, unhashable key, unsupported `\/`, truncated Unicode, lone surrogate, unsupported character literal, unexpected character, and trailing data. Assert exact `detail`, `offset`, and `str(error) == f"{detail} at offset {offset}"`. Keep a named strict `\/` regression.

  Run: `cd server && uv run pytest -q -o addopts='' tests/test_edn.py -k 'structured or solidus'`  
  Expected: `EdnError` lacks fields.

- [ ] **Step 3: Implement fields and convert every raise**

  ```python
  class EdnError(ValueError):
      def __init__(self, detail: str, offset: int) -> None:
          self.detail = detail
          self.offset = offset
          super().__init__(f"{detail} at offset {offset}")
  ```

  Record map-key form starts for unhashable-key offsets; report unsupported escapes at backslash; trailing data after `_skip_ws`; do not add solidus to escape table.

- [ ] **Step 4: Verify and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_edn.py
  uv run pyrefly check
  uv run ruff check src/pkm/edn.py tests/test_edn.py
  cd ..
  git add server/src/pkm/edn.py server/tests/test_edn.py .beans/pkm-5h2k--importer-cli-friendly-error-for-malformed-edn-expo.md
  git commit -m "fix(pkm-5h2k): structure EDN parser errors"
  ```

### Task 2: Friendly malformed-export CLI refusal

**Files:**
- Modify: `server/src/pkm/importer/run.py`
- Modify: `server/tests/test_importer_e2e.py`
- Modify: `pkm-5h2k` bean

- [ ] **Step 1: Write RED e2e test**

  Write malformed `"\\/"`, invoke importer, and assert return 2, empty stdout, exact stderr `error: malformed export at offset 1: unsupported escape '\/'`, no traceback, and no output directory.

  Run: `cd server && uv run pytest -q -o addopts='' tests/test_importer_e2e.py -k malformed_export`  
  Expected: uncaught traceback.

- [ ] **Step 2: Catch only parser errors**

  ```python
  try:
      parsed = parse_edn(export_path.read_text(encoding="utf-8"))
  except EdnError as exc:
      print(f"error: malformed export at offset {exc.offset}: {exc.detail}", file=sys.stderr)
      return 2
  ```

  Keep `parse_export`, decoding, title canonicalization, database, and asset work outside this catch.

- [ ] **Step 3: Verify, complete bean, and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_importer_e2e.py -k 'malformed_export or missing_export' tests/test_edn.py
  cd ..
  # Check both bean tasks, append strictness summary, then:
  beans update --json pkm-5h2k -s completed
  git add server/src/pkm/importer/run.py server/tests/test_importer_e2e.py .beans/pkm-5h2k--importer-cli-friendly-error-for-malformed-edn-expo.md
  git commit -m "fix(pkm-5h2k): report malformed imports cleanly"
  ```

### Task 3: Transport-neutral export structure preflight

**Files:**
- Create: `server/src/pkm/importer/preflight.py`
- Create: `server/tests/test_import_preflight.py`

**Interfaces:**
```python
StructureReason = Literal["duplicate_uid", "multi_parent"]
class ImportStructureError(ValueError):
    reason: StructureReason
    uid: str
    locations: tuple[str, ...]
def validate_export_structure(export: Export) -> None: ...
```
Location examples: `pages[0] 'A'.children[0].children[1]`, `orphan_blocks[0].children[0]`.

- [ ] **Step 1: Write pure RED tests**

  Distinct block objects sharing one UID produce `duplicate_uid`; the same block instance reached under two parents produces `multi_parent`. Assert deterministic UID selection and all structural locations.

  Run: `cd server && uv run pytest -q -o addopts='' tests/test_import_preflight.py`  
  Expected: missing module.

- [ ] **Step 2: Implement complete traversal core**

  Add `# pattern: Functional Core`. Gather `(location, id(block))` by UID across pages and orphans, then select lexicographically first offending UID after traversal so all locations are available. `ImportStructureError` formats label, repr UID, and semicolon-separated locations.

- [ ] **Step 3: Verify FCIS and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_import_preflight.py
  uv run pyrefly check
  uv run ruff check src/pkm/importer/preflight.py tests/test_import_preflight.py
  cd ..
  git add server/src/pkm/importer/preflight.py server/tests/test_import_preflight.py
  git commit -m "feat(pkm-x1ig): validate importer tree structure"
  ```

### Task 4: Refuse invalid trees before filesystem work

**Files:**
- Modify: `server/src/pkm/importer/run.py`
- Modify: `server/tests/test_importer_e2e.py`
- Modify: `pkm-x1ig` bean

- [ ] **Step 1: Write raw-EDN shell RED tests**

  Create multi-parent entity and duplicate UID exports. Seed existing database/report sentinels and monkeypatch linked-file indexing to fail if called. Assert return 2, `error: invalid export structure: ...`, reason/UID/locations, unchanged sentinels, and no temp files.

- [ ] **Step 2: Validate at exact shell boundary**

  Ordering:
  ```text
  verify file -> parse EDN -> parse_export -> validate_export_structure
  -> index linked files -> derive rows -> create output/temp database
  -> existing title canonicalization -> report/publication
  ```

  Catch only `ImportStructureError`, print friendly line, and return 2.

- [ ] **Step 3: Verify, check bean item, and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_import_preflight.py tests/test_importer_e2e.py -k 'invalid_tree or orphan_classes'
  cd ..
  git add server/src/pkm/importer/run.py server/tests/test_importer_e2e.py .beans/pkm-x1ig--importer-polish-dag-refusal-report-accuracy-compos.md
  git commit -m "fix(pkm-x1ig): refuse invalid import trees early"
  ```

### Task 5: Shared global Mermaid preservation planner

**Files:**
- Create: `server/src/pkm/importer/mermaid_preservation.py`
- Create: `server/tests/test_mermaid_preservation.py`

**Interfaces:**
```python
@dataclass(frozen=True)
class PreservedRef:
    descendant_uid: str
    source_uids: tuple[str, ...]
@dataclass(frozen=True)
class MermaidPreservationPlan:
    preserved_component_uids: frozenset[str]
    preserved_refs: tuple[PreservedRef, ...]
def plan_mermaid_preservation(
    component_descendants: Mapping[str, Set[str]],
    block_ref_sources: Mapping[str, Set[str]],
) -> MermaidPreservationPlan: ...
```

- [ ] **Step 1: Write transitive/deduplication RED tests**

  Inner component’s child is cited by a sibling inside outer but outside inner. Assert inner is directly protected, outer transitively protected, and one sorted `PreservedRef` row with unioned sources.

  Run: `cd server && uv run pytest -q -o addopts='' tests/test_mermaid_preservation.py`  
  Expected: missing module.

- [ ] **Step 2: Implement fixed-point planner**

  For each component, external sources are `sources - (descendants | {component})`; directly protect where nonempty and aggregate report sources. Repeatedly protect any candidate whose descendants intersect protected component UIDs. Sort report rows and sources.

- [ ] **Step 3: Verify FCIS and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_mermaid_preservation.py
  uv run pyrefly check
  uv run ruff check src/pkm/importer/mermaid_preservation.py tests/test_mermaid_preservation.py
  cd ..
  git add server/src/pkm/importer/mermaid_preservation.py server/tests/test_mermaid_preservation.py
  git commit -m "feat(pkm-x1ig): plan Mermaid preservation globally"
  ```

### Task 6: Apply global planning to fresh import rows

**Files:**
- Modify: `server/src/pkm/importer/rows.py`
- Modify: `server/tests/test_rows.py`

- [ ] **Step 1: Write nested Mermaid RED test**

  Outer Mermaid contains inner Mermaid with referenced line and sibling citer. Assert all four UIDs survive with original parent structure and `mermaid_preserved_refs == (("line", ("citer",)),)` once.

- [ ] **Step 2: Precollect candidates before walking**

  Traverse pages/orphans to map candidate UID to fence and full descendant UID set; call shared planner before row emission. During walk, suppress fence for every protected component. Populate report field once from planner; remove recursive `extend` reporting.

- [ ] **Step 3: Verify and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_rows.py -k mermaid
  uv run pytest -q -o addopts='' tests/test_report.py
  cd ..
  git add server/src/pkm/importer/rows.py server/tests/test_rows.py
  git commit -m "fix(pkm-x1ig): protect nested Mermaid import rows"
  ```

### Task 7: Correct implicit-page counts and orphan/Mermaid composition

**Files:**
- Modify: `server/src/pkm/importer/rows.py`
- Modify: `server/tests/test_rows.py`
- Modify: `pkm-x1ig` bean

- [ ] **Step 1: Write orphan-derived implicit-page RED test**

  Explicit page plus orphan text referencing `[[Orphan-only target]]`. Assert pages include explicit, target, and recovery page; `implicit_page_count == 1`.

- [ ] **Step 2: Calculate after orphan walk**

  ```python
  implicit_page_count = len(pages) - explicit - (1 if recovery_page_title is not None else 0)
  ```

- [ ] **Step 3: Add composition characterization**

  Orphan Mermaid with externally cited child stays unflattened on recovery page, child parent remains component, and report contains one pair. This should pass after Task 6; if it fails, fix only the global plan application.

- [ ] **Step 4: Verify and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_rows.py
  cd ..
  git add server/src/pkm/importer/rows.py server/tests/test_rows.py .beans/pkm-x1ig--importer-polish-dag-refusal-report-accuracy-compos.md
  git commit -m "fix(pkm-x1ig): count orphan-derived implicit pages"
  ```

### Task 8: Apply shared Mermaid protection to SQLite migration

**Files:**
- Modify: `server/src/pkm/importer/migrate_mermaid_blocks.py`
- Modify: `server/tests/test_migrate_mermaid_blocks.py`

**Interfaces:**
```python
@dataclass(frozen=True)
class Plan:
    candidates: tuple[tuple[str, str], ...]
    preserved: tuple[PreservedRef, ...]
def plan_migration(con: sqlite3.Connection) -> Plan: ...
def _print_preserved(preserved: tuple[PreservedRef, ...]) -> None: ...
```

- [ ] **Step 1: Write nested migration RED tests**

  Seed outer/inner/line/sibling citer. Assert neither inner nor outer is a candidate, both remain after normal migration, and one deduplicated preserved row exists. Add `_print_preserved(())` exact empty-output test.

- [ ] **Step 2: Gather shell inputs and call shared core**

  Gather candidate fences, component subtree UID sets, and all ref sources. Call planner; filter every protected UID from candidates. Remove local `Preserved` class. `_print_preserved` returns immediately when empty and otherwise prints descendant/source rows.

- [ ] **Step 3: Verify and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_mermaid_preservation.py tests/test_migrate_mermaid_blocks.py
  uv run pyrefly check
  uv run ruff check src/pkm/importer/mermaid_preservation.py src/pkm/importer/migrate_mermaid_blocks.py tests/test_migrate_mermaid_blocks.py
  cd ..
  git add server/src/pkm/importer/migrate_mermaid_blocks.py server/tests/test_migrate_mermaid_blocks.py .beans/pkm-x1ig--importer-polish-dag-refusal-report-accuracy-compos.md
  git commit -m "fix(pkm-x1ig): protect nested Mermaid migration rows"
  ```

### Task 9: Pin temporary-file boundaries

**Files:**
- Modify: `server/tests/test_importer_e2e.py`
- Modify production only if a RED assertion reveals mismatch with approved behavior

- [ ] **Step 1: Strengthen report failure test**

  Assert both `pkm.sqlite3.tmp` and `import-report.txt.tmp` are absent after report render/write/publication failure while published sentinels remain.

- [ ] **Step 2: Add publication-failure test**

  Fail database `os.replace`, assert original database/report unchanged and both named temps removed.

- [ ] **Step 3: Add early database-build and asset-copy tests**

  Inject invalid DDL and copy failure; assert unpublished `pkm.sqlite3.tmp` may remain, report temp does not, published sentinels remain, and a subsequent clean run removes stale temp and succeeds.

- [ ] **Step 4: Run boundary tests and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_importer_e2e.py -k 'report_failure or publication_failure or database_build_failure or asset_copy_failure or invalid_tree'
  cd ..
  git add server/tests/test_importer_e2e.py .beans/pkm-x1ig--importer-polish-dag-refusal-report-accuracy-compos.md
  git commit -m "test(pkm-x1ig): pin importer temp cleanup boundaries"
  ```

### Task 10: Documentation, bean completion, and lane gates

**Files:**
- Modify: `docs/architecture/backend.md`
- Modify: `pkm-x1ig` bean

- [ ] **Step 1: Correct architecture pipeline and invariants**

  Diagram: strict EDN parse -> parse_export -> structural preflight -> rows/global Mermaid plan -> DB/title canonicalization -> report/publication. Document friendly offset error and strict `\/`, duplicate/multi-parent refusal before I/O, transitive Mermaid ancestor protection and deduped reports, post-orphan implicit count, and exact temp cleanup boundaries.

- [ ] **Step 2: Search for stale claims**

  Ensure no docs claim universal temp cleanup, local/per-component preservation, component-keyed preserved rows, or pre-orphan implicit count.

- [ ] **Step 3: Run focused lane gates and FCIS audit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_edn.py tests/test_import_preflight.py tests/test_importer_e2e.py tests/test_mermaid_preservation.py tests/test_rows.py tests/test_report.py tests/test_migrate_mermaid_blocks.py
  uv run pyrefly check
  uv run ruff check
  ```

  Confirm `edn.py`, `preflight.py`, `mermaid_preservation.py`, and `rows.py` are Functional Core; `run.py` and `migrate_mermaid_blocks.py` are Imperative Shell; no duplicate Mermaid ancestor algorithm remains.

- [ ] **Step 4: Complete `pkm-x1ig` and commit**

  Check every item, append summary, mark completed only with no unchecked items.

  ```bash
  cd ..
  beans update --json pkm-x1ig -s completed
  git add docs/architecture/backend.md .beans/pkm-x1ig--importer-polish-dag-refusal-report-accuracy-compos.md
  git commit -m "docs(pkm-x1ig): complete importer follow-ups"
  ```
