---
# pkm-810w
title: 'Fix test suite gaps: e2e exclusion, handler-wiring seam, stale bracket-autopair test, unenforced coverage, Composer autocomplete coverage, smoke test'
status: in-progress
type: task
priority: normal
created_at: 2026-07-12T17:59:07Z
updated_at: 2026-07-12T19:58:23Z
---

Findings from test-suite audit (pkm-89yk). Not yet implemented — filing for future work.

## Findings

1. [P1] Standard verification excludes the only real browser tests. The documented commands stop at Vitest (CLAUDE.md:27), and Vitest explicitly excludes e2e/** (web/vite.config.ts:19). This currently hides a real failure: `pnpm test` passes 417/417, but `pnpm e2e` passes only 3/4.

2. [P1] Editor tests leave a false-positive seam at handler wiring. web/src/components/EditableBlockTree.test.tsx:9 verifies events against vi.fn() handlers, while functional tests call edit functions directly. Consequently, much of the real wiring in useOutline.ts:159 — outdent, move up/down, backspace, arrow navigation, collapse, heading, todo, and selection — was never executed in coverage. Wiring onMoveUp to moveBlockDown, for example, could remain green. Add EditablePage interaction tests through the actual hook.

3. [P2] The failing E2E is stale after bracket auto-pairing. Zero-delay `pressSequentially("[[")` in web/e2e/edit.spec.ts:38 outruns the requestAnimationFrame caret restoration. Playwright captured second block `[][]E2E Target`, so autocomplete never opens. The unit test already documents and manually handles this timing at EditableBlockTree.test.tsx:481. The browser test should enter the reference in a way consistent with the auto-pair behavior.

4. [P2] Coverage is high today but completely unenforced. Neither server/pyproject.toml:13 nor web/package.json:21 declares coverage tooling or thresholds. Transient measurement produced approximately:
   - Backend: 96% combined coverage, including branches.
   - Frontend: 95.27% statements, 91.92% branches, 89.3% functions.
   Without committed configuration or CI, these numbers can regress unnoticed.

5. [P2] Composer autocomplete is advertised behavior with no component coverage. Its three tests cover send, read-only, and upload, but not autocomplete selection or keyboard handling (web/src/components/Composer.test.tsx:6). Coverage confirms Composer.tsx:30 lines 30-55 are untouched: 76.81% statements and 53.84% branches.

6. [P3] The backend smoke test tests nothing beyond Python import semantics. server/tests/test_smoke.py:4 asserts an already-imported module is non-null. The import itself would fail before the assertion. Replace it with an installed entrypoint/version test or remove it.

## Additional harness concern

`reuseExistingServer: true` in playwright.config.ts:14 can bypass the purpose-built server and its exception log, weakening the E2E 5xx backstop.

## Verification snapshot at time of audit

Backend 330/330 passed; Vitest 417/417 passed; Playwright 3/4 passed.

## Checklist

- [x] Add real EditablePage handler-wiring interaction tests
- [x] Add Composer autocomplete interaction tests
- [x] Fix and include Playwright E2E in standard verification
- [x] Enforce frontend and backend coverage thresholds
- [x] Replace no-op backend smoke test
- [ ] Run full verification, summarize, commit, merge, and push

## Summary of Changes

- Added EditablePage interaction tests through the real useOutline handler wiring for outdent, move up/down, backspace, boundary navigation, collapse, headings, TODOs, and multi-block selection. A deliberate move-up/move-down mutation was caught by the new test.
- Added Composer autocomplete component coverage for mouse pick, ArrowUp/ArrowDown, Enter, Tab, and Escape.
- Repaired the bracket-auto-pair Playwright flow by waiting for animation-frame caret restoration, and forced Playwright to use its purpose-built scratch server.
- Added pnpm verify so standard web verification includes typecheck, thresholded Vitest coverage, build, and Playwright.
- Added thresholded branch-aware pytest coverage and replaced the import-only smoke assertion with installed-distribution metadata verification.
- Ignored generated coverage reports and documented the new verification commands.

Verification before integration: backend 363 passed at 95.70% coverage; pyrefly 0 errors; ruff clean; frontend 431 passed at 98.46% statements / 91.74% branches / 94.01% functions; Playwright 4/4 passed.
