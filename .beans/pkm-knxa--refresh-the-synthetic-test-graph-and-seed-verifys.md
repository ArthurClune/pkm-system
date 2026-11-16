---
# pkm-knxa
title: Refresh the synthetic test graph and seed verify's scratch server from it
status: completed
type: feature
created_at: 2026-11-16T18:38:10Z
updated_at: 2026-11-16T18:38:10Z
---

test-data/graph.json dates from July: it has no queries, {{table}} macros, attribute pages, Paper/Book namespace pages, DONE items, a second journal day, or a long page. The verify skill starts its scratch server on an empty DB.

- [x] Extend graph.json with current features (queries over :: attributes, {{table}}, Paper/ page, DONE items, second journal day, long page)
- [x] Update the fixture/generator tests that pin the graph
- [x] verify skill seeds its scratch server with pkm.test_data.generate
- [x] test-data/README.md coverage list
- [x] Check the generated graph renders in the app (queries, tables)

## Summary of Changes

test-data/graph.json gains Paper/ and Book/ pages laid out like
web/src/templates/, a Reading List page with a query in each view (a saved
table view over Book pages, a default table over Paper and Research, cards,
and line records over Article lines with Key:: children), a TODO/DONE query
on Project Atlas, a {{table}} block on Formatting Lab, a second journal day
with DONE items, and Garden Journal Archive, a {{toc}} page long enough to
scroll. test_test_data_fixture.py now checks feature coverage instead of
pinning the exact page and uid lists, and checks Paper/ and Book/ pages
against the template files; test_test_data_generator.py serves the generated
graph and checks each query view has records (and that the TODO query takes
the blocks default). The verify skill seeds its scratch server with
pkm.test_data.generate before setup.

Checked by driving the app on a scratch server seeded per the new recipe.
Seen there and filed separately: a PDF asset link in a query cell or card
embeds the whole viewer. The graph's {{embed: ((uid))}} block shows as text,
since the app has no embed macro.
