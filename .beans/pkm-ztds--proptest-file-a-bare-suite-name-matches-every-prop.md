---
# pkm-ztds
title: 'proptest --file: a bare suite name matches every props path'
status: completed
type: bug
priority: normal
created_at: 2026-10-06T10:00:48Z
updated_at: 2026-10-06T10:03:24Z
---

`proptest/check.sh web --file ops` runs every web props suite, not just ops: the filter is passed straight to vitest, which matches it as a substring of the file path, and every path under web/src/props/ contains "ops". Found 2026-10-06 running the ops suite for pkm-vfyn (it cost a full ~5-minute run instead of ~60 s).

Fix: resolve --file against web/src/props/ (a directory name such as `ops` becomes the `src/props/ops/` filter; a file such as `sync/sync.prop.ts` its full path), and refuse a name that resolves to nothing, listing the suites, rather than handing vitest a filter that may widen silently. The replay lines the suites print (`--file sync/sync.prop.ts`) must keep working.

- [x] Resolve and validate --file in server/tooling/proptest/run.py, with tests in server/tests/test_proptest_sides.py
- [x] Docs: property-checks.md and AGENTS.md describe --file as a suite name or path under web/src/props
- [x] Server tests, pyrefly, ruff

## Summary of Changes

`--file` is resolved against web/src/props by `resolve_file_filter` (sides.py, pure): a directory becomes `src/props/<dir>/`, a file `src/props/<file>`, a web-relative path is accepted, and an unknown name exits 2 listing the suites without running vitest. Docs updated in property-checks.md and AGENTS.md.
