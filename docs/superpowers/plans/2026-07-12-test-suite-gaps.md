# Test Suite Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close pkm-810w by making browser tests part of standard verification, covering real editor and Composer wiring, enforcing coverage floors, and replacing the meaningless backend smoke test.

**Architecture:** Keep runtime behavior unchanged. Add interaction tests at the `EditablePage` and `Composer` boundaries, configure native pytest/Vitest coverage gates, and make Playwright always own its scratch server so its exception backstop cannot be bypassed.

**Tech Stack:** React 18, Testing Library, Vitest 3 with V8 coverage, Playwright 1.61, Python 3.12, pytest with pytest-cov, uv, pnpm.

## Global Constraints

- Work test-first and verify each new interaction test against the real component boundary.
- Do not refactor production modules; this bean concerns test and verification gaps.
- Preserve the Functional Core / Imperative Shell classifications.
- Run server tests, server coverage/type/lint, web tests/coverage/typecheck, and Playwright before completion.

---

### Task 1: Editor handler-wiring interaction coverage

**Files:**
- Modify: `web/src/views/EditablePage.test.tsx`

**Interfaces:**
- Consumes: `EditablePage`, keyboard mappings in `EditableBlockTree`, and queued `BlockOp[]` batches from `makeSync()`.
- Produces: component-level tests that fail if `useOutline.handlers` routes outdent, move, backspace, arrow, collapse, heading, todo, or selection to the wrong edit command.

- [x] Add nested/sibling fixtures and interaction tests that exercise Shift+Tab, Alt+ArrowUp/Down, Backspace-at-start, boundary arrows, chevron click, `/h1` selection, TODO marker click, and Shift+Arrow selection through `EditablePage`.
- [x] Run `pnpm vitest run src/views/EditablePage.test.tsx` and confirm all interaction assertions pass against the current correct wiring.
- [x] Mutation-check at least move-up versus move-down by temporarily swapping the handler target, confirm the new test fails for the expected op, then restore the correct wiring.

### Task 2: Composer autocomplete component coverage

**Files:**
- Modify: `web/src/components/Composer.test.tsx`

**Interfaces:**
- Consumes: debounced `/api/titles` lookup, `AutocompletePopup`, `applyCompletion`, and Composer keyboard handling.
- Produces: tests for mouse selection plus ArrowUp/ArrowDown, Enter/Tab, and Escape behavior.

- [x] Add debounce-aware tests that type a `[[` query, resolve title rows, select a row, and assert the completed draft text.
- [x] Add keyboard tests proving row navigation/pick and Escape cancellation do not submit the Composer.
- [x] Run `pnpm vitest run src/components/Composer.test.tsx` and confirm the new tests pass.

### Task 3: Browser verification and stale bracket input

**Files:**
- Modify: `web/e2e/edit.spec.ts`
- Modify: `web/playwright.config.ts`
- Modify: `web/package.json`
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: bracket auto-pairing's animation-frame caret restoration and the purpose-built `server/tests/e2e_serve.py` server.
- Produces: reliable reference entry, an isolated Playwright server, and a `verify` script/documented command that includes unit tests, typecheck, and E2E.

- [x] Replace zero-delay sequential `[[` entry with explicit bracket key presses separated by a browser animation frame, then type the query.
- [x] Set `reuseExistingServer: false` so port 8975 collisions fail instead of silently reusing an unrelated server.
- [x] Add `test:unit`, `test:coverage`, and `verify` scripts while retaining `test` compatibility; document `pnpm verify` as standard web verification in `CLAUDE.md` and `README.md`.
- [x] Run `pnpm e2e` and confirm 4/4 browser tests pass.

### Task 4: Enforced frontend and backend coverage

**Files:**
- Modify: `web/package.json`
- Modify: `web/pnpm-lock.yaml`
- Modify: `web/vite.config.ts`
- Modify: `server/pyproject.toml`
- Modify: `server/uv.lock`
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Vitest V8 coverage and pytest-cov.
- Produces: committed branch-aware coverage configuration and commands that exit non-zero below conservative floors.

- [x] Run `pnpm test:coverage` and `uv run pytest --cov` before adding tooling to confirm the acceptance commands fail because coverage support is absent.
- [x] Add `@vitest/coverage-v8` at the installed Vitest version and `pytest-cov` to development dependencies.
- [x] Configure frontend thresholds no higher than the audited present values (statements 95, branches 91, functions 89, lines 95) and backend `--cov-branch --cov-fail-under=95` defaults.
- [x] Run both coverage commands and adjust only downward if fresh full-suite evidence is below an audited value because the current suite changed.

### Task 5: Meaningful installed-package smoke test

**Files:**
- Modify: `server/tests/test_smoke.py`

**Interfaces:**
- Consumes: installed distribution metadata for `pkm-server`.
- Produces: an assertion that the editable package is installed with the declared version, rather than asserting an already-imported module is non-null.

- [x] Replace the import-semantic assertion with `importlib.metadata.version("pkm-server") == "0.1.0"` and run the targeted test.
- [x] Confirm the test fails when given a nonexistent distribution name, restore the real distribution name, and rerun to pass.

### Task 6: Full verification, bean completion, and integration

**Files:**
- Modify: `.beans/pkm-810w--fix-test-suite-gaps-e2e-exclusion-handler-wiring-s.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a completed bean, verified commit, merge to `main`, and pushed branches.

- [x] Run `uv run pytest -q`, coverage, pyrefly, and ruff in `server/`.
- [x] Run `pnpm verify` in `web/` and inspect all output, including Playwright's server exception teardown.
- [x] Update the bean with checked findings and a summary, mark it completed, commit code and bean together, push the feature branch, merge with `--no-ff` into `main`, and push `main`.
