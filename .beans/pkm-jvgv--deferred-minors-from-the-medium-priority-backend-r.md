---
# pkm-jvgv
title: Deferred minors from the medium-priority backend reviews
status: completed
type: task
priority: low
created_at: 2026-08-18T18:34:47Z
updated_at: 2026-08-18T18:56:06Z
parent: pkm-wvvu
---

Review-deferred minor findings from pkm-byig / pkm-9w4f / pkm-2771 (reviews under the epic's 2026-08-17 sources; none block anything).

## Checklist

Test hygiene:
- [x] server/tests/test_query_parity.py duplicates the _client seeder from test_export_routes.py (third copy of _TEST_PASSWORD/_TEST_SALT); promote a shared helper module instead
- [x] Export parity tests assert no status code: add assert r.status_code == 200 in test_query_parity.py's export tests (the source-exclusion test can pass on any non-200 body)
- [x] test_refs.py blank-title guard: add a zero-width-space case pinning attribute_title_span('​:: v').title == '​' — the current cases only use characters str.lstrip() already treats as whitespace
- [x] test_planning.py:5-12 first-party import order not alphabetised

Docstrings/comments:
- [x] refs.attribute_title_span docstring says 'code-stripped block text' but rename._attribute_form legitimately passes a synthetic '{title}::' probe; widen the wording
- [x] refs.py:20 _ATTRIBUTE comment still points at extract() for the no-leading-\s* rationale, which now lives in attribute_title_span
- [x] docs/architecture/cli-and-mcp.md ~line 151 loose claim about Planner._one (inherited wording)

Typing/shape:
- [x] importer/titles.py _title_changes takes set[str]; AbstractSet/frozenset matches read-only intent and sibling signatures
- [x] _merge_sanitized_pages indexes (original, rebuilt) pairs positionally; a NamedTuple would name the roles

Coverage:
- [x] planning.py pre-existing uncovered lines: asset_block_text's pdf-macro and plain-link arms are a real hole in a user-visible output shape

The larger walker-dedup item was split out to pkm-mutr.

## Summary of Changes

All ten items fixed, one small pass per checklist group:

- **Test hygiene**: promoted test_export_routes.py's parameterized `_client`
  into `server/tests/app_seed.py::seeded_client` (bare-module import, same
  convention as `fake_engine.py`); test_query_parity.py now calls it instead
  of carrying its own third copy of the seeder and `_TEST_PASSWORD`/
  `_TEST_SALT`. Both /api/query and /api/export/page/Source responses in
  all three query-parity tests now assert `status_code == 200` before
  trusting the body. Added a zero-width-space (U+200B) case to
  `test_refs.py`'s blank-title guard, verified against real behaviour first
  (`attribute_title_span("​:: v").title == "​"`, confirmed, not
  blank -- matches the brief). Alphabetised test_planning.py's first-party
  imports.
- **Docstrings/comments**: widened `attribute_title_span`'s docstring to
  admit `rename._attribute_form`'s synthetic `f"{title}::"` probe, not just
  real code-stripped block text. Repointed the `_ATTRIBUTE` comment's
  no-leading-`\s*` rationale cross-reference from `extract()` to
  `attribute_title_span()`, where that logic actually lives. Fixed
  cli-and-mcp.md's inaccurate claim that `Planner._one` is "the one call
  site every create path funnels through" -- it isn't: an auto-created
  `## Heading` parent spec is split by `resolve_parent`'s own marker match,
  not by `split_heading`/`_one`. Ran check-docs.mjs (web/node_modules
  symlinked in temporarily, then removed) -- clean, no new long-sentence or
  broken-link warnings.
- **Typing/shape**: introduced `_PageRebuild(original, rebuilt)` NamedTuple
  in importer/titles.py so `_merge_sanitized_pages` names the roles instead
  of indexing `source[1].title` etc. Narrowed `_title_changes`'s
  `merged_pages_titles` param from `set[str]` to `AbstractSet[str]`
  (read-only intent, matches sibling `Mapping` params); its one caller still
  passes the mutable `set[str]` `_merge_sanitized_pages` returns. Both are
  shape-only, behaviour identical.
- **Coverage**: added three focused tests pinning `asset_block_text`'s three
  output shapes (image embed, `{{[[pdf]]: url}}` macro, plain `[name](url)`
  link) -- the pdf-macro and plain-link arms were previously uncovered.

Verification (from the worktree, `cd server`):
- `uv run pytest -q` -- full suite green, coverage gate passed.
- `uv run pyrefly check` (run from repo root) -- 0 errors.
- `uv run ruff check` -- all checks passed.

Four commits on `pkm-jvgv-deferred-minors`, one per checklist group: test
hygiene, docs/comments, typing/shape, and coverage (this bean update rides
with the coverage commit).
