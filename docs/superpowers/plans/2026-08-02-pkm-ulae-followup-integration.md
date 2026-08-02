# PKM ULAE Follow-up Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute and integrate the four follow-up plans, complete all seven child beans, verify the combined system, and complete `pkm-mk87` without running production migration.

**Architecture:** Land title integrity first because it introduces activation metadata and modifies shared replica/importer shells. Then branch traversal/ref/section, importer, and export lanes from that integrated title baseline; merge each with `--no-ff`. Resolve documentation/bean overlap centrally and run complete server/web gates only after all lanes merge.

**Tech Stack:** Git worktrees/branches, beans, Python/uv/pytest/pyrefly/ruff, TypeScript/pnpm/Vitest/Playwright.

## Global Constraints

- Integration branch is `pkm-mk87-ulae-followups` in `.worktrees/pkm-mk87-ulae-followups`.
- Use `git merge --no-ff` for every lane merge.
- Never run title audit/apply against production database, port `8974`, or production CLI config.
- Every behavior change follows RED/GREEN TDD in its lane plan.
- Architecture documentation and generated contracts must describe merged code, not plans or beans.
- Complete a bean only with no unchecked items and a `## Summary of Changes`.

---

### Task 1: Commit the plan set and mark planning complete

**Files:**
- Add the four lane plans and this integration plan
- Modify: `.beans/pkm-mk87--complete-all-pkm-ulae-follow-up-tidy-work.md`

- [ ] **Step 1: Run plan self-review checks**

  ```bash
  rg -n '\b(TBD|TODO|FIXME|XXX)\b|<[^>]+>' docs/superpowers/plans/2026-08-02-pkm-*.md
  rg -n '^### Task ' docs/superpowers/plans/2026-08-02-pkm-*.md
  git diff --check
  ```

  Expected: placeholder scan has no matches; task listing covers title, traversal/ref/section, importer, export, and integration.

- [ ] **Step 2: Check plan/spec coverage manually**

  Map every spec section to a lane task, verify shared function/type names match across tasks, and verify importer plan explicitly preserves title lane’s `run.py` canonicalization step.

- [ ] **Step 3: Mark plan complete and commit**

  ```bash
  beans update pkm-mk87 --body-replace-old "- [ ] Write implementation plan" --body-replace-new "- [x] Write implementation plan"
  git add docs/superpowers/plans/2026-08-02-pkm-title-integrity.md docs/superpowers/plans/2026-08-02-pkm-traversal-ref-section-parity.md docs/superpowers/plans/2026-08-02-pkm-importer-followups.md docs/superpowers/plans/2026-08-02-pkm-export-writer-polish.md docs/superpowers/plans/2026-08-02-pkm-ulae-followup-integration.md .beans/pkm-mk87--complete-all-pkm-ulae-follow-up-tidy-work.md
  git commit -m "docs(pkm-mk87): plan ulae follow-up implementation"
  ```

### Task 2: Execute and merge title integrity first

**Plan:** `docs/superpowers/plans/2026-08-02-pkm-title-integrity.md`

- [ ] **Step 1: Create isolated title lane from integration HEAD**

  Create branch/worktree `pkm-mk87-title-integrity` using the project worktree workflow. Install worktree-local server/web dependencies.

- [ ] **Step 2: Execute each title-plan task with fresh implementation and review agents**

  For every task: implementation agent follows TDD and commits; spec-compliance reviewer checks requirements; code-quality reviewer checks correctness/tests/FCIS. Fix findings before next task.

- [ ] **Step 3: Run title focused gates and isolated CLI verification**

  Use only `127.0.0.1:18974` and a temp CLI config. Preserve command output as bean summary evidence. Do not run full `pnpm verify` yet; run plan’s focused web checks and typecheck.

- [ ] **Step 4: Merge title lane**

  ```bash
  git checkout pkm-mk87-ulae-followups
  git merge --no-ff pkm-mk87-title-integrity
  ```

  Resolve conflicts only on integration branch, then rerun affected focused tests.

### Task 3: Execute remaining independent lanes from title baseline

**Plans:** traversal/ref/section, importer, export.

- [ ] **Step 1: Create three branches/worktrees from post-title integration HEAD**

  Branches:
  ```text
  pkm-mk87-parity
  pkm-mk87-importer
  pkm-mk87-export
  ```

- [ ] **Step 2: Dispatch lane execution in parallel**

  Each lane uses its own worktree, fresh task agents, TDD, per-task commits, spec review, and code-quality review. Agents may modify only files named by their lane plan. If a newly discovered requirement crosses lane boundaries, stop that lane and integrate the prerequisite centrally rather than duplicating logic.

- [ ] **Step 3: Run each lane’s focused gates**

  Parity runs focused server/web tests and checks. Importer/export run focused server tests plus pyrefly/ruff. Full repository gates wait for integration.

### Task 4: Merge remaining lanes with `--no-ff`

- [ ] **Step 1: Merge parity**

  ```bash
  git merge --no-ff pkm-mk87-parity
  ```

  Preserve title activation changes in shared `routes_pages.py`, `refs.py`, and `localOps.ts`; add parity changes around them. Rerun affected title/parity focused tests.

- [ ] **Step 2: Merge importer**

  ```bash
  git merge --no-ff pkm-mk87-importer
  ```

  Preserve title lane’s temporary-database canonicalization after structure preflight/database build and before publication. Preserve importer lane’s parse/preflight ordering before linked-file/output work. Rerun all importer and title-import tests.

- [ ] **Step 3: Merge export**

  ```bash
  git merge --no-ff pkm-mk87-export
  ```

  Resolve backend documentation by retaining both title/importer/export invariants in their correct sections. Rerun export focused tests.

- [ ] **Step 4: Inspect merged beans and generated files**

  Ensure seven target beans are completed or have only central integration tasks remaining; `pkm-8kw2` must contain both title-broadcast and parity summaries. Regenerate OpenAPI/types once from merged server code and assert no manual generated edits.

### Task 5: Architecture and cross-file consistency review

**Files:** `docs/architecture/*.md`, README, PKM skill, generated API files, changed runtime files.

- [ ] **Step 1: Verify architecture docs against code**

  Check backend API table/routes/models, title activation transaction, importer pipeline/temp boundaries, export telemetry/cleanup, section behavior, ref filtering, and sync/offline traversal/metadata/generation.

- [ ] **Step 2: Recheck stale counts and enumerations**

  ```bash
  rg -n 'the [0-9]+|[0-9]+ routes|[0-9]+ tools|three-step|ten MCP|depth.?100|assets_copied|temporary files|plain_space_title' docs README.md .claude/skills/pkm/SKILL.md
  ```

  Correct only claims made stale by this work.

- [ ] **Step 3: Audit FCIS declarations and boundaries**

  New title/importer core modules contain no I/O. New server shells contain orchestration only. Every modified/new runtime file retains a classification. Run web FCIS checker.

- [ ] **Step 4: Check coordinator documentation item**

  `beans update pkm-mk87 --body-replace-old "- [ ] Review architecture documentation" --body-replace-new "- [x] Review architecture documentation"`

### Task 6: Complete verification

- [ ] **Step 1: Run server suite with coverage**

  `cd server && uv run pytest -q`  
  Expected: all tests pass and coverage is at least 95%.

- [ ] **Step 2: Run server typecheck**

  `cd server && uv run pyrefly check`  
  Expected: zero errors.

- [ ] **Step 3: Run server lint**

  `cd server && uv run ruff check`  
  Expected: all checks pass.

- [ ] **Step 4: Run full web verification alone**

  `cd web && pnpm verify`  
  Expected: typecheck, lint, FCIS, coverage, build, and every Playwright test pass. Run alone rather than concurrently with server suite to avoid baseline lint-test resource timeout.

- [ ] **Step 5: Verify production safety evidence**

  Inspect shell commands, bean summaries, and git diff. Confirm no command targeted port 8974, no production DB/config was accessed, and only isolated temporary migration verification ran.

- [ ] **Step 6: Check coordinator verification item**

  `beans update pkm-mk87 --body-replace-old "- [ ] Run full server and web verification" --body-replace-new "- [x] Run full server and web verification"`

### Task 7: Final code review and bean completion

- [ ] **Step 1: Request final spec-compliance review**

  Reviewer reads approved spec, all five plans, merged diff, and seven child beans. It must report missing requirements, unchecked items, incorrect docs, or production-safety violations.

- [ ] **Step 2: Request final code-quality review**

  Reviewer checks migration atomicity/digest completeness/ref rewrite ordering, replica activation ordering, traversal cycle safety, parser offsets, Mermaid transitivity, filesystem no-follow cleanup, tests, generated artifacts, and FCIS.

- [ ] **Step 3: Fix findings test-first and rerun affected/full gates**

  Every behavior fix begins with a failing regression. Documentation-only corrections need no test run unless executable help/skill text consumes them.

- [ ] **Step 4: Verify target beans**

  ```bash
  beans show --json pkm-2ilw pkm-amq2 pkm-8kw2 pkm-dzgw pkm-5h2k pkm-xo6w pkm-x1ig
  ```

  Each status is `completed`, every task is checked, and every body has `## Summary of Changes`.

- [ ] **Step 5: Complete coordinator**

  Check all seven child completion items and final-review item. Append a summary listing child outcomes, verification counts, and explicit “production title migration not executed”. Mark `pkm-mk87` completed only with no unchecked items.

- [ ] **Step 6: Commit final metadata/review fixes**

  ```bash
  git add .beans docs/architecture README.md .claude/skills/pkm/SKILL.md
  git commit -m "docs(pkm-mk87): complete ulae follow-up tidy sweep"
  git status --short --branch
  git log --oneline --decorate --graph -20
  ```

  Final status must be clean on `pkm-mk87-ulae-followups`.
