---
# pkm-elyy
title: 'Perf check: S variant typing inside SearchBar''s debounce, counting requests'
status: todo
type: task
created_at: 2026-09-26T14:07:17Z
updated_at: 2026-09-26T14:07:17Z
---

## Gap

The frontend perf check's S scenarios (`web/tooling/perf/check.mjs`,
`search()`) type the query at a fixed pace well clear of SearchBar's
150 ms debounce, so every key sends its own search whether or not the
debounce works. A change that loses the debounce reads exactly the same,
and search is the spec's named hot spot
(`docs/superpowers/specs/2026-09-26-perf-regression-checks-design.md`).

## Proposal

Add an S variant that types the query well inside the debounce window
(keys much closer together than 150 ms) and counts `/api/search`
requests: with the debounce, one request for the whole query; without
it, one per key. Keep the existing paced variant for its timing.

Needs a frontend `perf/check.sh frontend --bootstrap` once added (new
scenario). Check that the count is identical across bootstrap runs; if
the tail keystroke races the debounce edge, wait for idle after typing
rather than widening to a band (spec Determinism step 2).

Found in the final review of pkm-q1hh (M4).
