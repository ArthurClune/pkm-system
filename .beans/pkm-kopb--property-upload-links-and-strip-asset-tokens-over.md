---
# pkm-kopb
title: 'Property: upload links and strip_asset_tokens over hostile filenames'
status: completed
type: task
priority: normal
created_at: 2026-10-21T14:01:04Z
updated_at: 2026-10-21T14:32:11Z
parent: pkm-a1xk
---

Same odd-filename family as `pkm-e7z9`, for uploads. Past bugs: deleting an upload with a space or parentheses in its name left debris like `[name.pdf]( for … .pdf)` (`strip_asset_tokens` stopped at the first space or `)`); an uploaded PDF with parentheses in its name lost its preview because `scanMarkdownLinkAt` closed the destination at the first `)` (`pkm-3jpg`).

## Ruling

Arthur's ruling on names a markdown link cannot hold (leading `[`, unbalanced
`]` or `)`): the server percent-encodes the filename segment of every
`/assets/<sha>/<name>` URL it returns, through one helper
(`assets_core.asset_url`, safe set `_.-~` plus alphanumerics). The GET route
serves by sha and ignores the segment, so raw-name links keep working. The
web label maps `[` to `(` and `]` to `)` (the stored name is untouched). The
bare-URL display decodes the segment, falling back to the raw text for a
stray `%`. `strip_asset_tokens` removes both the encoded and the raw legacy
spelling; legacy rows are not migrated.

## Checklist

- [x] Web: for any upload filename (reuse `hostileNameWith` from `web/src/outline/localLinkArbs.ts`, plus names the upload route accepts), the markdown the upload path inserts (image and file forms) reads back through `scanMarkdownLinkAt`/`tokenizeBlock` with the exact asset href, and a PDF is still recognised by `isPdfHref`.
- [x] Server: for any such filename and any surrounding text, `assets_core.strip_asset_tokens(text, sha)` removes every token naming that asset (link, image, bare URL) and leaves the rest of the text byte-identical; tokens of other assets survive.
- [x] Parity: the web-generated upload texts become a small shared fixture the server's stripper replays, so the two sides agree on what "a token for this asset" is.
- [x] Mutants: stop the URL at the first space; drop paren nesting in the destination scan.

## Ground rules (shared by this epic)

- Ordinary unit suites unless the bean says otherwise: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/` (`*.props.test.ts`). The `pkm-e7z9` files (`test_local_index_props.py`, `localLinkArbs.ts`, `localLinksParity.test.ts`) are the pattern to copy.
- Time budget: Arthur has OK'd a bigger budget than the default 100 examples where it buys real coverage. Keep `pytest -q` / `pnpm verify` reasonable; a property that needs minutes goes into the `proptest/check.sh` gate with its own budget instead (see `docs/architecture/property-checks.md`).
- A property is not covered until it is shown to reach (Hypothesis `event()`, or fast-check tallies asserted in the test so it cannot go vacuous) and to fail under a mutant. Record the rates and mutants in the commit message.
- Fix what the properties find, with the shrunk example kept as an ordinary unit test; never xfail or carve it out. A cross-language fixture gets a row in `backend.md` § Generated artifacts and parity fixtures.

## Summary of Changes

Properties over hostile upload names found that names like `[draft].png`, or with an unbalanced `]` or `)`, could not round-trip through the upload markdown and left debris on delete. Under the ruling above: `assets_core.asset_url` percent-encodes the name in every server-built asset URL, `asset_label` and `assetLabel` swap label brackets, `AssetLink` decodes the segment, and the stripper removes both spellings. Added web and server property tests, the `upload_links_parity.json` fixture with both replays, `test_asset_urls.py`, and the docs rows.
