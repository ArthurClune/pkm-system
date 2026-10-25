---
# pkm-bppf
title: Web tokenizer recurses per [[ nesting level; deep text breaks page rendering
status: in-progress
type: bug
priority: normal
created_at: 2026-10-23T19:33:04Z
updated_at: 2026-10-24T20:12:48Z
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
