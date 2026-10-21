---
# pkm-1xpl
title: 'Property: text and subtree hashes agree across server and web on odd text (lone surrogates)'
status: todo
type: task
created_at: 2026-10-21T14:01:04Z
updated_at: 2026-10-21T14:01:04Z
parent: pkm-a1xk
---

The offline conflict check compares a text hash the browser computes (`sha256Hex`, used by `subtreeHash`) with the server's (`contracts.ops.text_hash`, `subtree_hash`). The server uses Python's strict `text.encode()`; the browser presumably goes through `TextEncoder`, which turns a lone surrogate into U+FFFD. Unconfirmed hypothesis: a text holding a lone surrogate hashes differently on each side (a spurious conflict), or fails on the server (a rejected batch). `shared/fixtures/subtree_hash.json` pins chosen cases only.

## Checklist

- [ ] First confirm or rule out the hypothesis by hand: what the browser sends for a text with a lone surrogate, what `POST /api/ops` does with it (store, 4xx, 500), and what each side's hash is.
- [ ] Differential property over a generated fixture (web writes or server writes, whichever side generates more naturally): texts with NFC/NFD, astral emoji and ZWJ sequences, lone high and low surrogates, NUL, CRLF; both `text_hash`/`sha256Hex` and `subtree_hash`/`subtreeHash` agree.
- [ ] Web property: every text transform that slices by offset (block split at a caret, merge, paste splitting, auto-pair, slash-command replace, snippet truncation) never leaves a lone surrogate when its input had none. Find them by grepping `slice(`/`substring(` under `web/src/outline/` and `web/src/editor/`.
- [ ] If the server can receive a lone surrogate, decide the rule with Arthur (reject at the boundary with a 422 vs normalise to U+FFFD on both sides) and fix it.
- [ ] Mutants: e.g. hash the NFC form on one side only; split at a raw code-unit offset.

## Ground rules (shared by this epic)

- Ordinary unit suites unless the bean says otherwise: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/` (`*.props.test.ts`). The `pkm-e7z9` files (`test_local_index_props.py`, `localLinkArbs.ts`, `localLinksParity.test.ts`) are the pattern to copy.
- Time budget: Arthur has OK'd a bigger budget than the default 100 examples where it buys real coverage. Keep `pytest -q` / `pnpm verify` reasonable; a property that needs minutes goes into the `proptest/check.sh` gate with its own budget instead (see `docs/architecture/property-checks.md`).
- A property is not covered until it is shown to reach (Hypothesis `event()`, or fast-check tallies asserted in the test so it cannot go vacuous) and to fail under a mutant. Record the rates and mutants in the commit message.
- Fix what the properties find, with the shrunk example kept as an ordinary unit test; never xfail or carve it out. A cross-language fixture gets a row in `backend.md` § Generated artifacts and parity fixtures.
