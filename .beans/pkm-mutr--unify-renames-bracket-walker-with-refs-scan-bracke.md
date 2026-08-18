---
# pkm-mutr
title: Unify rename's bracket walker with refs._scan_brackets
status: todo
type: task
priority: low
created_at: 2026-08-18T18:45:23Z
updated_at: 2026-08-18T18:45:33Z
parent: pkm-wvvu
---

Split out of pkm-jvgv (its one materially-larger item). rename._matching_bracket_end/_scan_range duplicate refs._scan_brackets' depth walk. The two want different products: the extractor enumerates every nested title; the rewriter needs non-overlapping spans and must descend only when the outer title has no replacement. Unifying means refs exposing a positioned span *tree* — real behaviour-preservation risk, so pin current rewriter behaviour first (test_bare_tag_matches_hashtag_capture_class already guards the tag capture class).

## Acceptance criteria

- [ ] One owner for the bracket depth walk; no duplicated walker logic between refs.py and rename.py
- [ ] Rewriter behaviour preserved (nested descent, outer-wins, unbalanced brackets) with pinning tests written first
- [ ] Refine importer/titles.py's title-map invariant clause to 'any spelling extract() recognizes' once the walkers agree
- [ ] Grammar acceptance unchanged; shared fixtures and web/ untouched
