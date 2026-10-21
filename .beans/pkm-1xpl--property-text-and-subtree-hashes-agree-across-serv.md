---
# pkm-1xpl
title: 'Property: text and subtree hashes agree across server and web on odd text (lone surrogates)'
status: completed
type: task
created_at: 2026-10-21T14:01:04Z
updated_at: 2026-10-21T14:01:04Z
parent: pkm-a1xk
---

The offline conflict check compares a text hash the browser computes (`sha256Hex`, used by `subtreeHash`) with the server's (`contracts.ops.text_hash`, `subtree_hash`). The server uses Python's strict `text.encode()`; the browser presumably goes through `TextEncoder`, which turns a lone surrogate into U+FFFD. Unconfirmed hypothesis: a text holding a lone surrogate hashes differently on each side (a spurious conflict), or fails on the server (a rejected batch). `shared/fixtures/subtree_hash.json` pins chosen cases only.

## Checklist

- [x] First confirm or rule out the hypothesis by hand: what the browser sends for a text with a lone surrogate, what `POST /api/ops` does with it (store, 4xx, 500), and what each side's hash is.
- [x] Differential property over a generated fixture (web writes or server writes, whichever side generates more naturally): texts with NFC/NFD, astral emoji and ZWJ sequences, lone high and low surrogates, NUL, CRLF; both `text_hash`/`sha256Hex` and `subtree_hash`/`subtreeHash` agree.
- [x] Web property: every text transform that slices by offset (block split at a caret, merge, paste splitting, auto-pair, slash-command replace, snippet truncation) never leaves a lone surrogate when its input had none. Find them by grepping `slice(`/`substring(` under `web/src/outline/` and `web/src/editor/`.
- [x] If the server can receive a lone surrogate, decide the rule with Arthur (reject at the boundary with a 422 vs normalise to U+FFFD on both sides) and fix it.
- [x] Mutants: e.g. hash the NFC form on one side only; split at a raw code-unit offset.

## Confirmation

Confirmed live. `POST /api/ops` with `{"op":"update_text","uid":"uid_b4","text":"a\ud800b"}` (the JSON escape, which is exactly what the browser's well-formed `JSON.stringify` sends for a lone surrogate) returns 500: Python's `json` decodes the escape to a lone-surrogate `str`, pydantic accepts it, and `Db.execute` raises `UnicodeEncodeError: surrogates not allowed` in ops_apply `_execute`. `contracts.ops.text_hash` raises the same way. The web's `sha256Hex` goes through `TextEncoder`, which maps a lone surrogate to U+FFFD. The web outbox treats a 5xx as retryable (`web/src/sync/rejection.ts`), so such a batch retries forever and wedges every later edit behind it.

## Ruling

Arthur: normalise lone surrogates to U+FFFD on both sides, never reject.

- Server: at the contract boundary, for every client (web, MCP, CLI), every text the ops contract carries is normalised before apply and before hashing, by type (an `Annotated` str with a validator in contracts) rather than scattered calls. `text_hash`/`subtree_hash` are total and agree with `TextEncoder` for any `str`.
- Web: op text is normalised with `toWellFormed()` (or a helper) at the minimal choke point, so the local replica holds exactly what the server stores and hashes agree.

## Ground rules (shared by this epic)

- Ordinary unit suites unless the bean says otherwise: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/` (`*.props.test.ts`). The `pkm-e7z9` files (`test_local_index_props.py`, `localLinkArbs.ts`, `localLinksParity.test.ts`) are the pattern to copy.
- Time budget: Arthur has OK'd a bigger budget than the default 100 examples where it buys real coverage. Keep `pytest -q` / `pnpm verify` reasonable; a property that needs minutes goes into the `proptest/check.sh` gate with its own budget instead (see `docs/architecture/property-checks.md`).
- A property is not covered until it is shown to reach (Hypothesis `event()`, or fast-check tallies asserted in the test so it cannot go vacuous) and to fail under a mutant. Record the rates and mutants in the commit message.
- Fix what the properties find, with the shrunk example kept as an ordinary unit test; never xfail or carve it out. A cross-language fixture gets a row in `backend.md` § Generated artifacts and parity fixtures.

## Summary of Changes

- Server: `pkm/contracts/text.py` adds `well_formed` (lone surrogate to U+FFFD; a hand-built high/low pair joins) and `WellFormedModel`, a before model-validator that normalises every top-level str field. Every op model, `OpBatch` and the CLI/MCP batch command models (`batch.py`) derive from it, so text, titles, uids, batch and client ids are well-formed before validation, apply and hashing, for every client. It has to run before pydantic's own validation: a length-constrained field refuses a lone surrogate with a 422 whose echo then fails to encode (a 500 again). `text_hash`/`subtree_hash` hash the well-formed form, so they are total and agree with `TextEncoder`.
- Web: `replica/wellFormed.ts` (`wellFormed`, `wellFormedOp(s)`), applied at `opQueue.enqueue` (both the durable and the lane copy) and at `replica/queue.ts` `enqueueBatch` (the replica's own write door, which the offline shim's `create_page` uses without the queue).
- Property found real bugs: split, paste, upload splice, keyboard-bar insert, auto-pair, link/emphasis wraps, autocomplete and slash-command trigger strips all sliced at raw code-unit offsets, so an offset inside a pair left two lone surrogates. New `snapCaret` (`keyEdits.ts`) snaps every such offset; `stripTrigger` (`slashCommands.ts`) replaces BlockInput's four inline trigger strips.
- Fixture `shared/fixtures/text_hash_parity.json`, written by `web/src/replica/textHashParity.test.ts`, checked by `server/tests/test_text_hash_parity.py`; endpoint/unit/Hypothesis tests in `server/tests/test_well_formed_text.py`; web property `web/src/outline/surrogatePairs.props.test.ts`.
- Docs: backend.md (write path note, module map, fixture row), sync-and-offline.md, frontend-editor.md rule, frontend.md module map, two troubleshooting rows.
- Follow-ups for pkm-o42u are in the branch report (other request models and the FastAPI 422 echo).
