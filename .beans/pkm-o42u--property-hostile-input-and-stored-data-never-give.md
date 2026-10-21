---
# pkm-o42u
title: 'Property: hostile input and stored data never give a 500'
status: todo
type: task
priority: normal
created_at: 2026-10-21T14:01:04Z
updated_at: 2026-10-21T15:36:15Z
parent: pkm-a1xk
---

Past bugs where odd input or odd stored data gave a 500 instead of a 4xx or a clean answer: odd GoodLinks JSON (gateway passed any body on as a dict); a Roam-imported `:block/heading 0` failed response validation on page fetch and the changes feed; a spaces-only `[[   ]]` 500'd a whole `POST /api/ops`; the local file route served the wrong file for a trailing newline (`pkm-e7z9`).

## Checklist

- [ ] Request side: for the routes that take text, titles or uids (start with `/api/ops`, `/api/pages`, `/api/page/{title}`, search, rename, the CLI batch route), generate bodies and path or query values from the request models with hostile strings (control chars, lone surrogates, NFD, padding, `[[`, very long). The property: the answer is 2xx or 4xx, never 5xx, and a 2xx leaves the DB passing the row check (`PKM_ROW_CHECK=1`).
- [ ] Stored-data side: generate rows with every value the importers and older schema versions can write (the Roam heading 0 class) and check page fetch, journal, the snapshot and the changes feed serialise them.
- [ ] Upstream side: GoodLinks and the image-description gateway answer any generated JSON (`st.recursive` JSON) with a 503 or a clean payload, never a 500.
- [ ] Decide per route whether it fits the ordinary suite or needs the gate's budget.
- [ ] Mutants: drop one BlankTitleError catch; widen `HeadingLevel` back.

## Ground rules (shared by this epic)

- Ordinary unit suites unless the bean says otherwise: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/` (`*.props.test.ts`). The `pkm-e7z9` files (`test_local_index_props.py`, `localLinkArbs.ts`, `localLinksParity.test.ts`) are the pattern to copy.
- Time budget: Arthur has OK'd a bigger budget than the default 100 examples where it buys real coverage. Keep `pytest -q` / `pnpm verify` reasonable; a property that needs minutes goes into the `proptest/check.sh` gate with its own budget instead (see `docs/architecture/property-checks.md`).
- A property is not covered until it is shown to reach (Hypothesis `event()`, or fast-check tallies asserted in the test so it cannot go vacuous) and to fail under a mutant. Record the rates and mutants in the commit message.
- Fix what the properties find, with the shrunk example kept as an ordinary unit test; never xfail or carve it out. A cross-language fixture gets a row in `backend.md` § Generated artifacts and parity fixtures.


## Known lone-surrogate 500s (probed while fixing lone surrogates in ops)

Ops (`POST /api/ops`), the CLI and MCP batch paths now normalise lone
surrogates to U+FFFD (`pkm.contracts.text.WellFormedModel`). These still 500
under a TestClient probe:

- [ ] `POST /api/pages` `{title: "x\ud800"}` (`CreatePageRequest`): UnicodeEncodeError
- [ ] `POST /api/page/{title}/rename` `{new_title: "ML\ud800"}` (`RenamePageRequest`)
- [ ] `POST /api/sidebar` `{title: "S\ud800"}` (`AddSidebarEntryRequest`)
- [ ] App-wide: FastAPI's default `RequestValidationError` handler echoes the
  input, and an echo holding a lone surrogate fails to encode, so any 422 on
  such input becomes a 500 (e.g. `"op": "x\ud800"` in an ops batch, where
  union dispatch runs before the model validator). One fix: a custom handler
  that renders the echo well-formed.
- [ ] Probably `POST /api/client/diagnostics` and other StrictModel request
  bodies. The likely fix for request models is deriving them from
  `WellFormedModel`.

Fine as is: invalid-UTF-8 percent escapes in a path (`/api/page/%ED%A0%80`
gives 404) or a query (`/api/search?q=%ED%A0%80` gives 200).
