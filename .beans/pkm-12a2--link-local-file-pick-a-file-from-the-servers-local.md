---
# pkm-12a2
title: '/link-local-file: pick a file from the server''s local docs folder and insert a Local copy:: link'
status: completed
type: feature
priority: normal
created_at: 2026-10-21T09:59:24Z
updated_at: 2026-10-21T12:47:17Z
---

Slash command opens a read-only picker over Config.local_docs_root (browse folders, or fuzzy-search the whole tree). Picking a file inserts Local copy:: [<filename>](/api/local/<encoded path>) at the cursor. Removes the manual iCloud-Files lookup and the hand/assistant URL-encoding step, which can't be validated. Design: docs/superpowers/specs/2026-10-21-link-local-file-design.md


## Summary of Changes

- Server: `GET /api/local-index` lists `local_docs_root` in one response.
  - Each entry is a relative path plus its href, built by `local_docs.local_href`.
  - Hidden entries are skipped. iCloud `.X.icloud` stubs are listed as `X`, and stubs that unwrap to a dot-name are dropped.
  - A symlink is followed only when it resolves inside the root, and loops are visited once.
  - The scan runs on a daemon thread under a 5 s limit, with one scan in flight at a time (`TreeScanner`). A timeout, a missing root or an unreadable directory at any depth gives 503 + Retry-After.
  - Pure helpers live in `local_docs.py`, the shell in `server/local_index.py`.
- Web:
  - `/link-local-file` (label "link to local file…") strips the trigger, blurs, and opens `LocalFilePicker`. The picker is tree-owned like `/upload`. Its chunk is fetched on first use through a self-clearing cached import, so a failed load shows a notice in EditablePage's notice slot instead of crashing the app.
  - Browsing: breadcrumb, folders first, Backspace goes up.
  - Searching: `fzf` (fzf-for-js) `extendedMatch`, case-insensitive, scores unadjusted. Ties go first to name matches, then to shorter paths. Matching runs on NFC, so highlights are right on decomposed names. Results are not capped.
  - Keys: ↑/↓/Enter. Esc, Cancel or a backdrop click closes without inserting. Touch targets are larger under `pointer: coarse`.
  - Inserting: the splice is the same as `/goodlinks`. `Local copy:: [<name>](<href>)` keeps the real name unless the link reader couldn't read it back, in which case only the label's brackets become parentheses.
  - fzf lives in `outline/localSearch.ts` and stays out of the entry chunk: 407.7 KB of the 426.2 KB budget. Precache entries are now 90/90.
- Docs: backend.md (API row, module row, Local documents), frontend.md, frontend-editor.md, frontend-rendering.md, goodlinks.md, keyboard.md.
- Verification:
  - `pnpm verify` is green: 3988 unit tests and 82 e2e, including the new `e2e/link-local-file.spec.ts`.
  - Server pytest: 3561 tests, 97.6% coverage. pyrefly and ruff are clean.
  - perf: backend unchanged. The frontend counts improved slightly, and that baseline was committed; a re-run after the fixes showed no change.
  - The property checks were skipped: no sync, ops, outline-edit or undo code was touched.
- Follow-up: pkm-e7z9 (property tests for odd filenames).
