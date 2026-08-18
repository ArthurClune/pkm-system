---
# pkm-mutr
title: Unify rename's bracket walker with refs._scan_brackets
status: completed
type: task
priority: low
created_at: 2026-08-18T18:45:23Z
updated_at: 2026-08-18T19:45:21Z
parent: pkm-wvvu
---

Split out of pkm-jvgv (its one materially-larger item). rename._matching_bracket_end/_scan_range duplicate refs._scan_brackets' depth walk. The two want different products: the extractor enumerates every nested title; the rewriter needs non-overlapping spans and must descend only when the outer title has no replacement. Unifying means refs exposing a positioned span *tree* — real behaviour-preservation risk, so pin current rewriter behaviour first (test_bare_tag_matches_hashtag_capture_class already guards the tag capture class).

## Acceptance criteria

- [x] One owner for the bracket depth walk; no duplicated walker logic between refs.py and rename.py
- [x] Rewriter behaviour preserved (nested descent, outer-wins, unbalanced brackets) with pinning tests written first
- [x] Refine importer/titles.py's title-map invariant clause to 'any spelling extract() recognizes' once the walkers agree
- [x] Grammar acceptance unchanged; shared fixtures and web/ untouched

## Summary of Changes

`refs.py` now owns every positioned scan the grammar needs, and `rename.py`
consumes them instead of re-walking the text:

- `refs.bracket_spans(text)` returns a tree of `BracketSpan(start, end,
  inner_start, inner_end, is_tag, children)` — the old `_scan_brackets` depth
  walk, keeping offsets instead of copying substrings. `iter_bracket_spans()`
  flattens it outer-first, which is the order `extract()` reports refs in.
- `refs.tag_spans(text, start, stop)` owns `#tag` recognition. The bounds are
  a window, not a slice, so `_HASHTAG`'s lookbehind still reads the character
  before `start` — that is what lets the rewriter scan inside a bracket run
  and get the same answer.
- `refs.is_bare_tag_title()` answers "would this read back as `#title`?", and
  `_HASHTAG`/`_BARE_TAG` are now built from one `_TAG_NAME` constant, so
  `rename._tag_form()` no longer hand-copies the name class.
- `rename._matching_bracket_end` and `_scan_range` are gone. `_rewrite_range`
  walks the span tree, rewriting tags in the gaps between runs and descending
  into a run only when its own title has no replacement (outer-wins).

Two behaviours that look changed but are not: rename's `#[[Title]]` branch
disappeared because a span covering the bracket run alone leaves the `#` in
place, which spells the same result; and the hand-rolled `index == 0 or
prev.isspace() or prev == "("` tag boundary was exactly `_HASHTAG`'s anchor.

Written first and passing against the two-walker code (commit c9513b2):
pins for nested descent, outer-wins at depth, unbalanced/stray brackets, tag
boundaries, and a fixture-driven agreement test that renaming any title
`extract()` reports changes the text it was reported from.
`test_bare_tag_matches_hashtag_capture_class` was replaced — the duplication
it guarded no longer exists — by a refs-side construction check plus a
behavioural test that `_tag_form()` keeps the bare form iff `extract()` reads
that title back as a tag.

`shared/fixtures/` and `web/` untouched; `docs/architecture/backend.md`
updated where it said rename reaches into refs for `strip_code()` and
`attribute_title_span()` only.
