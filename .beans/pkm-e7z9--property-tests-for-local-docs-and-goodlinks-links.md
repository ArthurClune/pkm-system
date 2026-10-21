---
# pkm-e7z9
title: Property tests for local-docs and GoodLinks links (odd filenames)
status: todo
type: task
priority: normal
created_at: 2026-10-21T12:03:57Z
updated_at: 2026-10-21T12:04:02Z
blocked_by:
    - pkm-12a2
---

Property-based tests for the local-docs links (/link-local-file, `GET /api/local-index`, `/api/local/{path}`, `/api/local/check`) and the GoodLinks links. They focus on odd filenames.

These go in the ordinary unit suites: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/`, the way `web/src/replica/replay.test.ts` already does. They run on every `pytest -q` / `pnpm verify`. They are NOT `proptest/check.sh` suites, because that gate is for sync, ops and outline-edit invariants.

Why: the hand-written tests pin a few chosen names. The final review of the /link-local-file branch then found an NFD-offset bug (highlights on decomposed names) that those tests missed. Filenames in the iCloud folder are arbitrary: macOS stores them decomposed, and they can contain `%` `#` `?` `&` `+`, brackets, parentheses, quotes, emoji, leading dots and `.icloud` stubs.

Per AGENTS.md, a new property is not covered until it is shown to reach and to fail. Label the interesting cases with `event()`/`target()` (Hypothesis) or classifiers (fast-check) and read their rates. Then break the rule once with a mutant and confirm the property fails.

## Checklist
- [ ] Server, `GET /api/local-index` round trip (Hypothesis, tmp folder):
  - generate nested trees from a hostile name alphabet: NFC and NFD accents, `%#?&+`, brackets and parens, quotes, emoji, long names, leading dots, `.X.icloud` stubs, symlinks to files and dirs inside and outside the root, and a loop;
  - the listing equals the visible regular files inside the root, computed independently;
  - every listed href is served by `/api/local/{path}` (200, or 503 for a stub);
  - nothing outside the root is ever listed.
- [ ] Server, encoding (pure):
  - for any path `clean_relative` accepts, `resolve_relative(local_href(rel)[len(LOCAL_PREFIX):]) == rel`;
  - `extract_local_hrefs("Local copy:: [label](href)")` returns exactly `[href]`, for any label the web's `localCopyAttribute` can produce.
- [ ] Web, `localCopyAttribute` (fast-check). For any file name and server href:
  - the text parses as a `Local copy` attribute;
  - `scanMarkdownLinkAt` reads back that exact href;
  - the label equals the name unless the name has unbalanced brackets or a leading `[`, in which case only `[`/`]` differ;
  - the rendered link (InlineSegments) has that href.
- [ ] Web, `searchLocalFiles` (fast-check, NFC and NFD paths):
  - results are a subset of the input;
  - any file whose NFC path contains a query word as a case-insensitive substring is in the results;
  - highlight ranges are in bounds and their characters spell each query word in order.
- [ ] Optional, server/web link parity:
  - a shared fixture (like `shared/fixtures/refs_parity.json`) of generated `Local copy::` texts;
  - the server's `extract_local_hrefs` and the web's markdown-link reader agree on the hrefs.
- [ ] Optional, GoodLinks:
  - `goodlinksIdFromHref` accepts exactly `/api/goodlinks/<32 lowercase hex>`;
  - the `goodlinksCandidates` URL finder extracts a URL with trailing punctuation stripped from any surrounding text;
  - `goodlinksAttribute` reads back through the link reader.
- [ ] Each property is shown to reach (event or classifier rates recorded in the commit message) and to fail under a mutant.
- [ ] Any product bug found is fixed with the shrunk example kept as an ordinary unit test.

Builds on the /link-local-file feature (pkm-12a2). Start after that branch merges.
