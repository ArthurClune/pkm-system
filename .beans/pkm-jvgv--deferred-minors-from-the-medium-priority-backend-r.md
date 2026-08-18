---
# pkm-jvgv
title: Deferred minors from the medium-priority backend reviews
status: todo
type: task
priority: low
created_at: 2026-08-18T18:34:47Z
updated_at: 2026-08-18T18:34:54Z
parent: pkm-wvvu
---

Review-deferred minor findings from pkm-byig / pkm-9w4f / pkm-2771 (reviews under the epic's 2026-08-17 sources; none block anything).

## Checklist

Test hygiene:
- [ ] server/tests/test_query_parity.py duplicates the _client seeder from test_export_routes.py (third copy of _TEST_PASSWORD/_TEST_SALT); promote a shared helper module instead
- [ ] Export parity tests assert no status code: add assert r.status_code == 200 in test_query_parity.py's export tests (the source-exclusion test can pass on any non-200 body)
- [ ] test_refs.py blank-title guard: add a zero-width-space case pinning attribute_title_span('​:: v').title == '​' — the current cases only use characters str.lstrip() already treats as whitespace
- [ ] test_planning.py:5-12 first-party import order not alphabetised

Docstrings/comments:
- [ ] refs.attribute_title_span docstring says 'code-stripped block text' but rename._attribute_form legitimately passes a synthetic '{title}::' probe; widen the wording
- [ ] refs.py:20 _ATTRIBUTE comment still points at extract() for the no-leading-\s* rationale, which now lives in attribute_title_span
- [ ] docs/architecture/cli-and-mcp.md ~line 151 loose claim about Planner._one (inherited wording)

Typing/shape:
- [ ] importer/titles.py _title_changes takes set[str]; AbstractSet/frozenset matches read-only intent and sibling signatures
- [ ] _merge_sanitized_pages indexes (original, rebuilt) pairs positionally; a NamedTuple would name the roles

Coverage:
- [ ] planning.py pre-existing uncovered lines: asset_block_text's pdf-macro and plain-link arms are a real hole in a user-visible output shape

Larger, own judgement call (split out if picked up):
- [ ] rename._matching_bracket_end/_scan_range still duplicate refs._scan_brackets' depth walk; unifying means exposing a positioned span tree — materially bigger, behaviour-preservation risk. When done, also refine the titles.py invariant clause to 'any spelling extract() recognizes'.
