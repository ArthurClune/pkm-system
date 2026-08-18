---
# pkm-9w4f
title: Expose a stable title-span API and simplify import title sanitization
status: completed
type: task
priority: normal
tags:
    - review
    - backend
created_at: 2026-08-17T20:55:21Z
updated_at: 2026-08-18T18:08:57Z
parent: pkm-wvvu
---

## Review findings

Backend A5 and the `sanitize_export_titles` complexity finding. Import title rewriting reaches through private refs APIs and compensates for rename attribute matching, while collision merging is embedded in a 100-line function.

## Acceptance criteria

- [x] Define a public title-span or normalizer-aware rewrite boundary owned by `refs.py` or `rename.py`
- [x] Remove importer and rename dependencies on refs private names where they cross module boundaries
- [x] Make raw-versus-normalized attribute-prefix handling explicit in the owning abstraction
- [x] Extract the collision-group, survivor-selection, and reorder phase from `sanitize_export_titles`
- [x] Pin attributes, bracket refs, code spans, collisions, ordering, and whitespace behavior with focused tests
- [x] Document the new module boundary if it changes the backend architecture

## Summary of Changes

Both halves of the finding are gone: no module reaches into `refs.py` privates
any more, and `sanitize_export_titles` is four named phases.

**`refs.py` owns the seam.** New public `strip_code()` (was `_strip_code`) and
`attribute_title_span()` returning a frozen `AttributeSpan(start, end,
raw_title, title)`. The span holds the written and the normalized spelling
together, and owns the attribute's whitespace anchoring: `lstrip()` for the
offset, then one `_ATTRIBUTE.match(text, offset)` there, so the span starts at
the title and never inside the indent. `extract()` now reads its attribute ref
from that helper. Its old `if title := ...` blank guard is gone because the
helper cannot report a blank title -- the scan starts past every leading
whitespace character, so the captured name begins with a non-whitespace one.
That invariant is documented on the helper and pinned by a test.

**`rename.py` takes the normalizer.** Imports the two public names instead of
`_ATTRIBUTE`/`_strip_code`, and `rewrite_title_refs_map()` grew a keyword-only
`normalize: Callable[[str], str]` defaulting to verbatim matching. It is
applied through one `_title_lookup()` closure that `_scan_range()` receives in
place of the raw mapping, so raw-versus-normalized is decided in a single
place. Rename and the title migration keep the default -- their keys are
stored page titles, padding included, which the migration exists to change.
The importer passes `refs.normalize_title` because its keys come from
`extract()`.

**`importer/titles.py` lost its bridge.** `_rewrite_import_title_refs` (and
with it the `_scan_brackets` pre-pass, the re-derived attribute prefix and the
`text[attribute_start:]` slicing) is deleted; `_rewrite_block` calls
`rewrite_title_refs_map(..., normalize=normalize_title)` directly.
`sanitize_export_titles` is now `_collect_title_locations` -> title map ->
rebuild -> `_merge_sanitized_pages` -> `_title_changes`, pure code motion with
each phase's rule stated in its docstring.

**One deliberate behaviour change, in the rename path only.** Unifying the
attribute anchor makes `rename.py` agree with `extract()` on indented
attributes, where it previously disagreed in two ways: `"  Old:: v"` kept its
ref but lost the indent, and `"\n Old:: v"` was not rewritten at all even
though `extract()` indexes it as a ref, leaving a stale reference after a
rename. Both are now rewritten with the indent intact. The importer path is
unchanged -- it already compensated for exactly this.

Tests: 14 new in `test_rename.py`, 5 in `test_refs.py` (two parametrized), 3
in `test_import_titles.py`. Characterization tests landed in their own commit
first and stayed green; the three tests covering the intended change were red
before the refactor. Gates: `pytest -q` 1533 passed, coverage 97.19%;
`pyrefly check` 0 errors; `ruff check` clean.

Review follow-up (`b1aa477`) corrected two documentation claims. The importer's
key set is not simply "what `extract()` reported" -- `_collect_title_locations`
also records raw export page titles, which can hold control whitespace
`extract()` never reports; the invariant that makes the normalize-only lookup
safe is now stated where the key set is built. And the behaviour change above
is larger than first described: a column-0 attribute match also swallowed a
leading code span, so a rename could splice the new title over a `code` run or
a whole fence. That variant is named in the symptom row and pinned by a test.
