---
# pkm-kopb
title: 'Property: upload links and strip_asset_tokens over hostile filenames'
status: todo
type: task
created_at: 2026-10-21T14:01:04Z
updated_at: 2026-10-21T14:01:04Z
parent: pkm-a1xk
---

Same odd-filename family as `pkm-e7z9`, for uploads. Past bugs: deleting an upload with a space or parentheses in its name left debris like `[name.pdf]( for … .pdf)` (`strip_asset_tokens` stopped at the first space or `)`); an uploaded PDF with parentheses in its name lost its preview because `scanMarkdownLinkAt` closed the destination at the first `)` (`pkm-3jpg`).

## Checklist

- [ ] Web: for any upload filename (reuse `hostileNameWith` from `web/src/outline/localLinkArbs.ts`, plus names the upload route accepts), the markdown the upload path inserts (image and file forms) reads back through `scanMarkdownLinkAt`/`tokenizeBlock` with the exact asset href, and a PDF is still recognised by `isPdfHref`.
- [ ] Server: for any such filename and any surrounding text, `assets_core.strip_asset_tokens(text, sha)` removes every token naming that asset (link, image, bare URL) and leaves the rest of the text byte-identical; tokens of other assets survive.
- [ ] Parity: the web-generated upload texts become a small shared fixture the server's stripper replays, so the two sides agree on what "a token for this asset" is.
- [ ] Mutants: stop the URL at the first space; drop paren nesting in the destination scan.

## Ground rules (shared by this epic)

- Ordinary unit suites unless the bean says otherwise: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/` (`*.props.test.ts`). The `pkm-e7z9` files (`test_local_index_props.py`, `localLinkArbs.ts`, `localLinksParity.test.ts`) are the pattern to copy.
- Time budget: Arthur has OK'd a bigger budget than the default 100 examples where it buys real coverage. Keep `pytest -q` / `pnpm verify` reasonable; a property that needs minutes goes into the `proptest/check.sh` gate with its own budget instead (see `docs/architecture/property-checks.md`).
- A property is not covered until it is shown to reach (Hypothesis `event()`, or fast-check tallies asserted in the test so it cannot go vacuous) and to fail under a mutant. Record the rates and mutants in the commit message.
- Fix what the properties find, with the shrunk example kept as an ordinary unit test; never xfail or carve it out. A cross-language fixture gets a row in `backend.md` § Generated artifacts and parity fixtures.
