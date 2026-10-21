---
# pkm-e7z9
title: Property tests for local-docs and GoodLinks links (odd filenames)
status: completed
type: task
priority: normal
created_at: 2026-10-21T12:03:57Z
updated_at: 2026-10-21T13:36:01Z
blocked_by:
    - pkm-12a2
---

Property-based tests for the local-docs links (/link-local-file, `GET /api/local-index`, `/api/local/{path}`, `/api/local/check`) and the GoodLinks links. They focus on odd filenames.

These go in the ordinary unit suites: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/`, the way `web/src/replica/replay.test.ts` already does. They run on every `pytest -q` / `pnpm verify`. They are NOT `proptest/check.sh` suites, because that gate is for sync, ops and outline-edit invariants.

Why: the hand-written tests pin a few chosen names. The final review of the /link-local-file branch then found an NFD-offset bug (highlights on decomposed names) that those tests missed. Filenames in the iCloud folder are arbitrary: macOS stores them decomposed, and they can contain `%` `#` `?` `&` `+`, brackets, parentheses, quotes, emoji, leading dots and `.icloud` stubs.

Per AGENTS.md, a new property is not covered until it is shown to reach and to fail. Label the interesting cases with `event()`/`target()` (Hypothesis) or classifiers (fast-check) and read their rates. Then break the rule once with a mutant and confirm the property fails.

## Checklist
- [x] Server, `GET /api/local-index` round trip (Hypothesis, tmp folder):
  - generate nested trees from a hostile name alphabet: NFC and NFD accents, `%#?&+`, brackets and parens, quotes, emoji, long names, leading dots, `.X.icloud` stubs, symlinks to files and dirs inside and outside the root, and a loop;
  - the listing equals the visible regular files inside the root, computed independently;
  - every listed href is served by `/api/local/{path}` (200, or 503 for a stub);
  - nothing outside the root is ever listed.
- [x] Server, encoding (pure):
  - for any path `clean_relative` accepts, `resolve_relative(local_href(rel)[len(LOCAL_PREFIX):]) == rel`;
  - `extract_local_hrefs("Local copy:: [label](href)")` returns exactly `[href]`, for any label the web's `localCopyAttribute` can produce.
- [x] Web, `localCopyAttribute` (fast-check). For any file name and server href:
  - the text parses as a `Local copy` attribute;
  - `scanMarkdownLinkAt` reads back that exact href;
  - the label equals the name unless the name has unbalanced brackets or a leading `[`, in which case only `[`/`]` differ;
  - the rendered link (InlineSegments) has that href.
- [x] Web, `searchLocalFiles` (fast-check, NFC and NFD paths):
  - results are a subset of the input;
  - any file whose NFC path contains a query word as a case-insensitive substring is in the results;
  - highlight ranges are in bounds and their characters spell each query word in order.
- [x] Optional, server/web link parity:
  - a shared fixture (like `shared/fixtures/refs_parity.json`) of generated `Local copy::` texts;
  - the server's `extract_local_hrefs` and the web's markdown-link reader agree on the hrefs.
- [x] Optional, GoodLinks:
  - `goodlinksIdFromHref` accepts exactly `/api/goodlinks/<32 lowercase hex>`;
  - the `goodlinksCandidates` URL finder extracts a URL with trailing punctuation stripped from any surrounding text;
  - `goodlinksAttribute` reads back through the link reader.
- [x] Each property is shown to reach (event or classifier rates recorded in the commit message) and to fail under a mutant.
- [x] Any product bug found is fixed with the shrunk example kept as an ordinary unit test.

Builds on the /link-local-file feature (pkm-12a2). Start after that branch merges.

## Summary of Changes

Property tests, all in the ordinary suites:

- Server (Hypothesis): `test_local_index_props.py` (generated hostile trees through `/api/local-index` and the file route, against an independent model; directory symlinks inside the root get a weaker identity-based property because the walker enters each resolved directory once), `test_local_docs_props.py` (href round trip, `extract_local_hrefs` over every label the web can produce), `test_goodlinks_props.py`.
- Web (fast-check): `localFiles.props.test.tsx`, `localSearch.props.test.ts`, `goodlinks.props.test.ts` (outline and components), generators in `localLinkArbs.ts`. Classifier counts are asserted inside the tests so they cannot go vacuous.
- Parity: `shared/fixtures/local_links_parity.json`, written by `localLinksParity.test.ts` (fixed seed; `UPDATE_LOCAL_LINKS_FIXTURE=1`) and read by `server/tests/test_local_links_parity.py`.

Bugs the properties found, fixed with the shrunk examples as unit tests:

- A file name with a backslash was listed but 404'd. A name with a newline was listed, and `/api/local/a%0A` served file `a` (the `path` convertor's `$` stops before a final newline). `clean_relative` now also rejects control characters, `visible_name` skips anything `clean_relative` rejects, and the file route uses a DOTALL `wholepath` convertor.
- A picker query containing `İ` never matched (fzf folds item characters to the first code point of their lowercase; the query is now folded the same way).
- Test infra: Starlette's `TestClient` double-decodes percent-escapes; `conftest.py` gains `asgi_get_all` / `single_decode_get` and the percent-in-filename route tests use them.

Mutants (16 server, 7 web) all killed, except one equivalent web mutant (selecting the raw path instead of NFC: fzf normalises items itself). Rates and mutants are in the commit messages.
