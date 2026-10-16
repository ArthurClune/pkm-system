---
# pkm-rfkp
title: 'Comment-rot lint: pre-commit hook rejects bean ids, line-number and orphaned spec/plan pointers in comments'
status: completed
type: task
priority: normal
created_at: 2026-10-16T17:52:47Z
updated_at: 2026-10-16T18:03:50Z
---

Comments that explain local code hold up; comments that point elsewhere by position, number or nickname rot silently. Found on main: keyboardPolicy.ts:127 cites 'line 177 below' (now 187/195); twelve files say '(spec section N)' without naming the spec (it is docs/superpowers/specs/2026-07-12-offline-editing-design.md); edits.ts:6 cites a 'plan-3 contract note'. The no-bean-ids-in-comments rule in AGENTS.md is convention only.

## Rule

In source comments (web/src, server/src, server/tooling, web/tooling, perf, proptest) and docs/architecture prose, no:
1. bean ids (`pkm-xxxx`)
2. positional references (`line 177`, `lines 40-50`, `L177`, `file.ts:123`)
3. orphaned pointers (`spec section N`, `plan-N`, `per the spec`) with no `docs/...` path on the line

## Checklist

- [x] `server/tooling/commentlint/` — Functional Core (`core.py`: text -> violations) + Imperative Shell (`run.py`: staged files, print, exit), stdlib only
- [x] `.githooks/pre-commit` (python) runs it against every staged file under the scanned roots; any violation in a touched file fails
- [x] pytest coverage for core and shell
- [x] fix the existing violations: the sweep found 77 (70 spec/plan pointers, 7 line numbers; the remaining bean ids were all in perf baseline reports, which are excluded as records)
- [x] AGENTS.md: rule paragraph + hook note in Git section
- [x] docs: backend.md Testing bullet and overview.md FCIS section mention the hook; no troubleshooting row (a rule, not a fix)

## Summary of Changes

- `server/tooling/commentlint/core.py` (Functional Core) finds comment spans per language (`#`, docstrings, `//`, `/* */`, markdown prose) and applies three rules: `bean-id`, `line-number`, `orphan-pointer` (exempt when the line names a `docs/` path or a `.md` filename). `run.py` (Imperative Shell) lints the staged copy of staged files, or `--all` the tracked tree. Tests in `server/tests/test_commentlint_core.py` and `test_commentlint_run.py`, the latter driving the real hook in a scratch repo.
- `.githooks/pre-commit` (Python, stdlib) fails a commit when any staged file under web/src, web/e2e, web/tooling, server/src, server/tests, server/tooling, perf, proptest or docs/architecture breaks a rule. Generated files and `web/tooling/perf/baselines/` (measurement records named after beans) are excluded.
- Swept the 77 existing sites: `(spec section N)` -> `(offline-editing-design.md §N)` across 45 files (the offline spec's `## Section N` headings), `plan 5:`/`plan-4`/`plan-3` pointers dropped, seven line-number references replaced by symbol names (three were already pointing at the wrong line), and `openapi.json`/`types.d.ts` regenerated for the relinked Pydantic docstring.
- AGENTS.md, backend.md and overview.md state the rule and the hook.
