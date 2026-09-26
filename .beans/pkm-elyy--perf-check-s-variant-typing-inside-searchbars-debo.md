---
# pkm-elyy
title: 'Perf check: S variant typing inside SearchBar''s debounce, counting requests'
status: completed
type: task
priority: normal
created_at: 2026-09-26T14:07:17Z
updated_at: 2026-09-26T17:48:33Z
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



## Summary of Changes

`web/tooling/perf/check.mjs`: added `S/search-burst`, a new scenario that
types the whole query with 25 ms between keys (well inside `SearchBar`'s
150 ms debounce — confirmed in `web/src/components/SearchBar.tsx`), waits
for that term's `Create page` row, then for network idle, and records
`search_requests` as `exact`. The existing paced `S/search-common` and
`S/search-rare` variants are unchanged. No orchestrator change was needed:
the scenario id still starts with letter `S`, already covered by
`_CONTEXT_GROUPS`' `"JKS"` in `server/tooling/perfcheck/run_core.py`.

Verified: `perf/check.sh frontend --bootstrap` (5 runs) recorded
`search_requests: {class: exact, value: 1}` identically across all 5 runs;
two further `perf/check.sh frontend` runs both `no changes against the
baseline`.
