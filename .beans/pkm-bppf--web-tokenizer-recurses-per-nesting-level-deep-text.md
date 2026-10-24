---
# pkm-bppf
title: Web tokenizer recurses per [[ nesting level; deep text breaks page rendering
status: todo
type: bug
priority: normal
created_at: 2026-10-23T19:33:04Z
updated_at: 2026-10-24T19:02:24Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Found during the pkm-lbj1 review fixes (2026-10-23). tokenizeInline (web/src/grammar/tokenize.ts) recurses once per level of non-ref [[ nesting. Fine at depth 1,300; overflows (RangeError) between 4,124 and 4,132 in node 26. /api/ops does not bound nesting (the ops guard judges only runs that are refs), so text like "[[a//"*n + "[[Deep]]" + "]]"*n is accepted; an assistant write (prompt injection) or a paste could make a page fail to render. Prod's deepest nesting on 2026-10-23 was 2.

- [ ] Red vitest: tokenizeInline on the [[a// shape at depth 5,000 does not throw and yields the same segments as a shallow equivalent scaled
- [ ] Iterative tokenizer for nested [[ (equivalence test against the current one at depths it handles), or decide a server-side nesting bound for writes (Arthur's call: that would be a product limit)
- [ ] Check the server/web parity fixtures still pass
- [ ] troubleshooting.md row

## Decision (Arthur, 2026-10-24)

See docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md, row pkm-bppf.
