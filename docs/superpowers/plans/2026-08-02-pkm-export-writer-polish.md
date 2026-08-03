# PKM Export Writer Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate fresh-copy and corruption-repair telemetry, safely remove abandoned export staging entries before last-good mutation, and document warning lifetime.

**Architecture:** Filesystem orchestration stays in the existing imperative-shell writer. A tiny pure classifier owns copy-versus-repair semantics. Preserve the single-writer and three-subtree publication model; add neither locking nor age heuristics.

**Tech Stack:** Python 3.12, pathlib, shutil, SQLite, pytest, uv, pyrefly, ruff.

## Global Constraints

- Fresh transfers increment only `assets_copied`; corrupt replacements increment only `assets_repaired`.
- Cleanup assumes one writer per export directory; do not add advisory locking or age thresholds.
- Matching symlinks are unlinked, never recursively followed.
- Vanished entries are success; other cleanup errors propagate.
- Cleanup precedes `.gitignore` writes, rendering, staging creation, and publication.
- Preserve current independent `pages/`, `journal/`, and `assets/` swaps.
- A successful assets publication normally suppresses later missing-source warnings; pre-publication failure may repeat them.
- `assets_core.py` remains Functional Core; `writer.py` remains Imperative Shell.
- No generated API/web files change.

---

### Task 1: Disjoint copy/repair telemetry

**Files:**
- Modify: `server/src/pkm/assets_core.py`
- Modify: `server/src/pkm/export/writer.py`
- Modify: `server/tests/test_assets_core.py`
- Modify: `server/tests/test_export_writer.py`
- Modify: `server/tests/test_backup_cli.py`
- Modify: `.beans/pkm-amq2--export-writer-polish-repair-telemetry-staging-dir.md`

**Interfaces:**
```python
def classify_export_asset_transfer(destination_was_present: bool) -> Literal["copied", "repaired"]: ...
```
`export_graph()` returns `pages`, `journal`, `assets_copied`, `assets_repaired`, `assets_pruned`, and `assets_missing_source_on_repair`.

- [ ] **Step 1: Mark `pkm-amq2` in progress**

  `beans update --json pkm-amq2 -s in-progress`

- [ ] **Step 2: Write classifier RED test**

  ```python
  @pytest.mark.parametrize(("was_present", "expected"), [(False, "copied"), (True, "repaired")])
  def test_classifies_export_asset_transfer(was_present, expected):
      assert classify_export_asset_transfer(was_present) == expected
  ```

  Run: `cd server && uv run pytest -q -o addopts='' tests/test_assets_core.py -k classifies_export`  
  Expected: missing import.

- [ ] **Step 3: Implement classifier**

  ```python
  def classify_export_asset_transfer(destination_was_present: bool) -> Literal["copied", "repaired"]:
      return "repaired" if destination_was_present else "copied"
  ```

- [ ] **Step 4: Write writer/backup RED assertions**

  Add `assets_repaired: 0` to exact dictionaries. Fresh export requires copied 1/repaired 0. Both corruption repairs require copied 0/repaired 1. Missing source increments neither transfer count. Backup stdout must contain both keys. Extend missing-source test with a second successful run: zero missing-source count and no warning.

  Run focused exact test names from `test_export_writer.py` plus new backup test.  
  Expected: missing key, repairs counted as copied, backup output missing repaired key.

- [ ] **Step 5: Implement disjoint counts**

  Initialize `assets_repaired`. Capture whether destination existed before verification/copy. After successful `copy2`, classify and increment exactly one counter. Existing valid hardlink and missing source increment neither.

- [ ] **Step 6: Verify, check bean item, and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_assets_core.py tests/test_export_writer.py tests/test_backup_cli.py
  uv run pyrefly check
  uv run ruff check
  cd ..
  beans update pkm-amq2 --body-replace-old "- [ ] Add assets_repaired to export_graph's counts and the backup log line" --body-replace-new "- [x] Add disjoint assets_repaired telemetry to export_graph and backup output"
  git add server/src/pkm/assets_core.py server/src/pkm/export/writer.py server/tests/test_assets_core.py server/tests/test_export_writer.py server/tests/test_backup_cli.py .beans/pkm-amq2--export-writer-polish-repair-telemetry-staging-dir.md
  git commit -m "fix(pkm-amq2): split asset copy and repair telemetry"
  ```

### Task 2: No-follow abandoned staging cleanup

**Files:**
- Modify: `server/src/pkm/export/writer.py`
- Modify: `server/tests/test_export_writer.py`
- Modify: `pkm-amq2` bean

**Interface:**
```python
def _remove_abandoned_staging(export_dir: Path) -> None: ...
```

- [ ] **Step 1: Write abandoned-directory RED test**

  Create `.export-staging-abandoned/partial.md`, call export, assert entry and every matching staging path are gone.

  Run targeted test. Expected: abandoned directory remains.

- [ ] **Step 2: Implement minimal directory cleanup, then write symlink RED test**

  Initial helper loops `export_dir.glob(".export-staging-*")`. Symlink test creates matching link to external directory and asserts link disappears while target marker survives. Expected RED if `rmtree` is called on link.

- [ ] **Step 3: Implement explicit no-follow behavior**

  ```python
  def _remove_abandoned_staging(export_dir: Path) -> None:
      for entry in export_dir.glob(".export-staging-*"):
          try:
              if entry.is_symlink():
                  entry.unlink()
              else:
                  shutil.rmtree(entry)
          except FileNotFoundError:
              pass
  ```

  Do not catch `OSError`, `PermissionError`, or `NotADirectoryError`.

- [ ] **Step 4: Write disappearance and persistent-error ordering tests**

  Monkeypatch `rmtree` to delete then raise `FileNotFoundError`; export succeeds. Separately create a last-good export with `.gitignore` sentinel, make abandoned cleanup raise `PermissionError`, snapshot tree, and assert exception plus byte-identical snapshot.

- [ ] **Step 5: Call cleanup before every last-good mutation**

  Beginning of `export_graph()`:
  ```python
  export_dir.mkdir(parents=True, exist_ok=True)
  _remove_abandoned_staging(export_dir)
  (export_dir / ".gitignore").write_text(GITIGNORE, encoding="utf-8")
  ```

- [ ] **Step 6: Verify, check bean item, and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_export_writer.py -k 'abandoned or staging_cleanup'
  cd ..
  beans update pkm-amq2 --body-replace-old "- [ ] Sweep abandoned .export-staging-* dirs at run start, with a test" --body-replace-new "- [x] Sweep abandoned staging entries before last-good mutation with no-follow handling"
  git add server/src/pkm/export/writer.py server/tests/test_export_writer.py .beans/pkm-amq2--export-writer-polish-repair-telemetry-staging-dir.md
  git commit -m "fix(pkm-amq2): safely sweep abandoned export staging"
  ```

### Task 3: Document invariants and warning lifetime

**Files:**
- Modify: `server/src/pkm/export/writer.py` module documentation
- Modify: `docs/architecture/backend.md`
- Modify: `pkm-amq2` bean

- [ ] **Step 1: Document implementation exactly**

  State single-writer invariant; cleanup before `.gitignore`/last-good trees; symlink unlink vs directory recursion; disappearance success; persistent error abort; no lock/age heuristic. Explain successful assets publication drops corrupt missing-source residue so warning is normally one successful-run event, while failure before assets publication can repeat it.

- [ ] **Step 2: Document telemetry**

  Backend docs distinguish fresh `assets_copied`, successful `assets_repaired`, and `assets_missing_source_on_repair` where no transfer occurred. Confirm nightly output renders all counts through existing generic dictionary output.

- [ ] **Step 3: Review claims against code**

  Verify call order, narrow exception, unlink branch, no lock/timestamp, warning before publication, and repaired increment only after successful copy.

- [ ] **Step 4: Check final bean item and commit**

  ```bash
  beans update pkm-amq2 --body-replace-old "- [ ] Document the one-shot missing-source warning" --body-replace-new "- [x] Document the successful-publication warning lifetime and repeat case"
  git add server/src/pkm/export/writer.py docs/architecture/backend.md .beans/pkm-amq2--export-writer-polish-repair-telemetry-staging-dir.md
  git commit -m "docs(pkm-amq2): explain export cleanup and warning lifetime"
  ```

### Task 4: Verification and bean completion

- [ ] **Step 1: Run focused export gates**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_assets_core.py tests/test_export_writer.py tests/test_backup_cli.py
  uv run pyrefly check
  uv run ruff check
  ```

- [ ] **Step 2: Inspect FCIS and scope**

  Confirm classifier only in Functional Core; all filesystem logic only in writer shell; backup code and export route unchanged; no generated files changed.

- [ ] **Step 3: Complete bean and commit**

  Check every task, append `## Summary of Changes` with counts/cleanup/docs/tests, then:
  ```bash
  cd ..
  beans update --json pkm-amq2 -s completed
  git add .beans/pkm-amq2--export-writer-polish-repair-telemetry-staging-dir.md
  git commit -m "docs(pkm-amq2): complete export writer polish"
  ```
