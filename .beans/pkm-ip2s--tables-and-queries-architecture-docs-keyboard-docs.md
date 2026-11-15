---
# pkm-ip2s
title: 'Tables and queries: architecture docs, keyboard docs and merge gates'
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T22:28:36Z
parent: pkm-l79g
---

Task 14 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.


## Progress

- [x] Step 1: architecture and keyboard docs brought in line with the shipped code
- [ ] Step 2: merge gates

## Summary of Changes

Architecture docs (backend, frontend, frontend-editor, frontend-rendering, sync-and-offline, styling, checks, contracts/frontend-editor) and docs/keyboard.md describe the shipped tables and queries. Gates run serially at branch end: server pytest, pyrefly, ruff; pnpm verify; proptest server and web; perf backend (query/records recorded new) and frontend (H/cold api_bytes +2 from the fixture's random db_generation, accepted by Arthur and re-recorded; harness bean pkm-7c4i). Entry budget raised for the help page's table keys. Arthur checked Tab, Shift-Tab, Esc and Shift-Enter on the iPad against a scratch build: all working.
