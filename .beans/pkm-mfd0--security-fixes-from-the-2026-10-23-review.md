---
# pkm-mfd0
title: Security fixes from the 2026-10-23 review
status: completed
type: epic
priority: high
created_at: 2026-10-23T10:55:47Z
updated_at: 2026-10-29T18:06:29Z
---

Actions from docs/security-review-2026-10-23.md (both passes). The review doc holds the findings, reproductions and limits; each child bean names the finding it acts on. docs/SECURITY.md stays the high-level model and is updated last, once the fixes we take on have landed.

## Summary of Changes

All children are done: 63 completed and 7 scrapped. This closes the 2026-10-23 review's findings. Arthur's calls are in docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md.

- **Network edge:** origin guard on writes and the WebSocket; per-source login backoff; anonymous requests refused before their body is read, with bounded public bodies and deadlines; a cookie-parsing 500 fixed.
- **Write paths:** caps on block text, `[[` nesting, title length and request size, enforced on every path. Replay and page-delete work is budgeted. Title whitespace folds, and refused refs are refused in the editor.
- **Assistant:** a smaller tool surface (no `upload_asset`, no `../`). The approval card shows current text and guards Allow against later edits. The panel reports refusals, failures and skipped ops. The harness and pkm-mcp start with an allow-listed environment.
- **Exports, pages and queries:** no hostile-input 500s and bounded work; APFS-safe zip names.
- **Off-machine copies:** the iCloud mirror leaves out the session secret and refuses files that contain it.
- **Dependencies:** production advisories upgraded away, except two react-router v6 ones (pkm-ov19). Dev-tool advisories are tracked in pkm-vrnh.
- **Gates:** a property gate covers titles and ops landings, plus an anonymous route walk and floor tests.
- **Docs:** SECURITY.md describes the system as shipped.

Follow-ups outside the epic: pkm-ov19 (react-router v7), pkm-cxq5 (mcp 2), pkm-vrnh (dev-tool advisories), pkm-tsb2 (perf harness), pkm-u48q (GoodLinks images, paused).
