---
# pkm-gc3n
title: Cap block text length (the guard every export review hit)
status: completed
type: task
priority: low
created_at: 2026-10-24T17:12:46Z
updated_at: 2026-10-25T03:41:50Z
parent: pkm-mfd0
---

From pkm-8bga's reviews. No block-text length cap exists, so the per-call transient memory in pkm.export.resolve.resolve_text scales with the largest stored block: one text of unresolvable refs ('((abcdefg))' * 500k) peaks at ~37 B/char while scanned (Match objects + event tuples), '{{query:}}' * 500k at ~30 B/char; a 10 MB block is ~370 MB transient, outside the export budget. A write-time cap (ops, importer, CLI) would bound this and the remaining 'W unbounded' cases. Needs Arthur's call on the cap and on what happens to existing over-cap rows (check prod copy for the largest block first). Review: .superpowers/sdd/2026-10-24-page-export-size-cap/task-1-rereview-4.md (gitignored, security/8bga worktree).

- [x] Write-time length limit (MAX_BLOCK_TEXT_CHARS, 1,000,000 code points) judged by pkm/text_limits.py, refused by /api/ops (CLI, MCP and assistant included)
- [x] Server-made rewrites (rename, merge, title migration, page delete, asset delete) refuse a block made worse on a limit; refusal bodies carry an excerpt and text_length
- [x] Importer refuses an export holding an over-limit block, naming its page
- [x] Web editor, undo, link-unlinked and replica refuse before queueing, with a notice; nothing truncated
- [x] Parity fixture shared/fixtures/text_limits_parity.json
- [x] Both property suites draw over-limit text, with teeth
- [x] troubleshooting.md row and architecture docs

## Decision (Arthur, 2026-10-24)

See docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md, row pkm-gc3n.

## Summary of Changes

Shipped on security/limits with pkm-gc3n and pkm-bppf together:
- Limits: MAX_BLOCK_TEXT_CHARS = 1,000,000 code points (Python len / web code points) and MAX_LINK_NESTING = 32 levels of [[, one measure shared by server (pkm/text_limits.py, refs.link_nesting_depth) and web (grammar/textLimits.ts, scan.ts linkNestingDepth), pinned by the generated parity fixture shared/fixtures/text_limits_parity.json.
- Refused on every write path: /api/ops (CLI, MCP and the assistant go through it), the replica and op queue backstops, server-made rewrites (rename 422, merge, title migration 409, page delete 'limit' blocker, asset delete 409 — judged per axis so legacy rows can only improve), the stale-edit replay (lands the client's text as a conflict entry instead of storing past a limit), the importer (refused, naming the page) and migrate_mermaid_blocks. Refusals carry an explicit excerpt + text_length, never a silent cut.
- Editor: an edit or paste past a limit shows a notice and does not apply; nothing is truncated.
- Rendering: the web grammar never throws or freezes at the cap (no unbounded argument spreads; linear bracket pairing, macros, math, URLs, spaced titles); a legacy block nested past 32 renders without page-ref tokens.
- Grammar parity fix: after a closing fence, only an ASCII word character [A-Za-z0-9_] makes an opener, on both sides (prod had none otherwise).
- Property gate: both suites draw past-limit, at-limit, fence-hidden and astral at-cap texts with an independent oracle and teeth.
- Docs: backend.md § Planning/Ref grammar, frontend docs, sync-and-offline.md, cli.md, troubleshooting rows.
- Follow-ups filed: pkm-25u5, pkm-gr92, pkm-0l8g, pkm-49rh, pkm-iruc, pkm-cfi2, pkm-9y7y, stale-unlink +2, ops property budget.
