---
# pkm-bppf
title: Web tokenizer recurses per [[ nesting level; deep text breaks page rendering
status: completed
type: bug
priority: normal
created_at: 2026-10-23T19:33:04Z
updated_at: 2026-10-25T03:41:50Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Found during the pkm-lbj1 review fixes (2026-10-23). tokenizeInline (web/src/grammar/tokenize.ts) recurses once per level of non-ref [[ nesting. Fine at depth 1,300; overflows (RangeError) between 4,124 and 4,132 in node 26. /api/ops does not bound nesting (the ops guard judges only runs that are refs), so text like "[[a//"*n + "[[Deep]]" + "]]"*n is accepted; an assistant write (prompt injection) or a paste could make a page fail to render. Prod's deepest nesting on 2026-10-23 was 2.

- [x] Write-time nesting limit (MAX_LINK_NESTING, 32) on every write path: /api/ops, server-made rewrites, importer; the web editor, undo, link-unlinked and replica refuse before queueing
- [x] Parity fixture shared/fixtures/text_limits_parity.json pins refs.link_nesting_depth and scan.linkNestingDepth equal; the fence-closer word test is ASCII on both sides
- [x] Render fallback: scanGrammar reports no [[ run tokens past the limit, so a legacy row renders its brackets as text; grammar scans linear at the length cap
- [x] Server and web parity fixtures pass
- [x] troubleshooting.md rows and architecture docs

## Decision (Arthur, 2026-10-24)

See docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md, row pkm-bppf.

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
