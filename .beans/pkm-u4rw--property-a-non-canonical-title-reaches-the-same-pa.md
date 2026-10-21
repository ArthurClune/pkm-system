---
# pkm-u4rw
title: 'Property: a non-canonical title reaches the same page through every route'
status: completed
type: task
priority: normal
created_at: 2026-10-21T14:01:04Z
updated_at: 2026-10-21T16:51:08Z
parent: pkm-a1xk
---

A cluster of past bugs where a padded or otherwise non-canonical title reached a route and missed: delete page 404'd on a page opened through `[[ Foo ]]`; a CLI rename 404'd; a todos/changed `page` filter and a `{{query}}` with `[[ Foo ]]` matched nothing; `/page/Paper%20` lost remote edits after a resync; a sidebar panel keyed by the requested title never saw other devices' edits.

## Checklist

- [x] Server: for any title and any padding or whitespace variant that canonicalises to it (`refs.target_canonical_title`), every route and CLI verb that takes a title (page get, delete, rename, todos/changed filters, queries, sidebar entries, journal) resolves the variant to the same page as the canonical form.
- [x] Web/replica parity: the replica's `canonicalTitle` and `titleSyntaxReason` (`web/src/replica/titles.ts`) agree with the server's `target_canonical_title` and `title_syntax_reason` on a generated fixture (extend `title_syntax.json` the way the refs corpus does).
- [x] Web: every surface that keys a session by title (`useOutlinePageLoad`, `EditableSidebarPanel`, the page loader) keys by the canonical title for any variant.
- [x] This needs the real server and many routes, so it may belong in the `proptest/check.sh` gate as a new suite; decide after the unit-level parity part. Decided: ordinary suites. The server properties run the app in-process over a fresh database copy per example (60 route examples, 30 CLI examples: about 7 s together), the web ones render the real hooks and views with a stub fetch (40 runs each, about 5 s). Neither needs a real server process or minutes of budget.
- [x] Mutants: one route that skips canonicalisation; key a sidebar panel by the raw title.

## Ground rules (shared by this epic)

- Ordinary unit suites unless the bean says otherwise: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/` (`*.props.test.ts`). The `pkm-e7z9` files (`test_local_index_props.py`, `localLinkArbs.ts`, `localLinksParity.test.ts`) are the pattern to copy.
- Time budget: Arthur has OK'd a bigger budget than the default 100 examples where it buys real coverage. Keep `pytest -q` / `pnpm verify` reasonable; a property that needs minutes goes into the `proptest/check.sh` gate with its own budget instead (see `docs/architecture/property-checks.md`).
- A property is not covered until it is shown to reach (Hypothesis `event()`, or fast-check tallies asserted in the test so it cannot go vacuous) and to fail under a mutant. Record the rates and mutants in the commit message.
- Fix what the properties find, with the shrunk example kept as an ordinary unit test; never xfail or carve it out. A cross-language fixture gets a row in `backend.md` § Generated artifacts and parity fixtures.

## Summary of Changes

- `shared/fixtures/title_parity.json` (`pkm.title_parity_dump`, 600 seeded titles) pins the replica's title identity, syntax reason, blankness and ref read-back to the server's. It found the replica trimming and matching `\s` with JS's whitespace set (U+FEFF, U+001C-U+001F, U+0085 differ); `grammar/scan.ts` now uses Python's set, and the replica's blank checks go through `isBlankTitle`.
- `server/tests/test_title_routes_props.py`: every title-taking route (enumerated from the OpenAPI document) and CLI verb (from the argparse parser) answers a generated variant spelling exactly as the title, with the plain-space flag on and off. It found four bugs, all fixed with unit tests: the page routes' `path` convertor dropped a final newline and matched no inner one (now `{title:wholepath}`); a page export 500'd on a non-latin-1 title (RFC 5987 `filename*`); an orphan edit's conflict header linked the hint's own spelling (now the stored title, `ops_apply._hint_page`); a `pkm batch` naming one page by two spellings planned each on its own copy and landed blocks out of order (`batch.page_keys`, reading the flag via a one-change `/api/sync/changes` window only when padding alone tells spellings apart).
- `web/src/outline/titleKeys.props.test.tsx`: `useOutlinePageLoad`, `EditableSidebarPanel` and the page view key their outline by the canonical title for any variant. It found that a `/page/` URL with a control character matched no route; `App.tsx`'s `MainRoutes` now redirects it to the folded title.
- Out of scope, filed as pkm-6mxb: titles with a `.`, `..` or empty path segment have no working URL; both properties leave them out of their draws until that is decided.
- Gate decision: ordinary suites, not `proptest/check.sh` (about 7 s server, 5 s web).

## Ruling (Arthur, 2026-10-21)

- Keep the plain-space flag read through a one-change `/api/sync/changes` window (`PkmClient.plain_space_title_canonicalization`): it is the same contract the web replica reads the flag from. No dedicated route.
