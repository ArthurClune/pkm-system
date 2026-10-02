# Property checks

`proptest/check.sh` is a Hypothesis property-based gate for the sync and
planning invariants: two generators drive random op batches and CLI batches
against the real server and compare the result with a from-the-docs reference
model. It runs locally before a merge, the same way
[`perf/check.sh`](performance-checks.md) does; it is not CI, a git hook, or
part of `pytest -q` or `pnpm verify`.

What to do with a failure is in
[`AGENTS.md` § Testing](../../AGENTS.md#testing). The rationale and rejected
alternatives are in the
[design spec](../superpowers/specs/2026-10-02-property-checks-server-design.md).

## Running it

```
proptest/check.sh [auto|server|web] [--seed N]
```

`auto` (the default) picks sides from the diff against `main`, the same rule
as `perf/check.sh`: `server/…` runs the server side, `web/…` the web side.
Only `server` exists yet; naming `web` prints "no properties yet" until a
later sub-project adds one. `--seed N` reproduces a specific run
(`--hypothesis-seed=N`); without it, each run explores a new random seed.

| Module | Pattern | Role |
|---|---|---|
| `proptest/check.sh` | script | wrapper: `TZ=Europe/London`, `python -m proptest.run` |
| `server/tooling/proptest/run.py` | Imperative Shell | git diff, then `uv run pytest -m proptest --no-cov tests/props` under `HYPOTHESIS_PROFILE=merge` |
| `server/tooling/proptest/sides.py` | Functional Core | `sides_for(changed_paths)`, mirrors `perfcheck.run_core.sides_for` |
| `server/tests/props/conftest.py` | test | Hypothesis profiles (`merge`, `dev`), the `template_db` fixture |
| `server/tests/props/harness.py` | test | non-fixture helpers every property needs: `template_db_path`, `fresh_app`, `FROZEN_NOW`, `MERGE_EXAMPLES`, `assert_unique_keys`/`assert_well_formed` |
| `server/tests/props/strategies.py` | Functional Core | uid pools, trees with gapped keys, op and CLI-command strategies |
| `server/tests/props/model.py` | test | the reference model (below) |
| `server/tests/props/test_ops_state.py`, `test_planner_props.py` | test | the two properties |
| `server/tests/props/test_model.py` | test | unmarked, runs in the normal suite: pins the model's own behaviour |

The suite lives under `server/tests/props/` so it shares `tests/conftest.py`
fixtures and pyrefly/ruff cover it, but a registered `proptest` marker
(`pytestmark` in every property module) keeps it out of `pytest -q`: `addopts`
carries `-m "not proptest"`.

**The custom-`-m` trap.** A pytest `-m` you pass on the command line replaces
`addopts`' filter rather than adding to it, so `pytest -q -m "not slow"` would
run the properties too. Add `and not proptest` to any custom `-m` you run
against this repo. `tests/test_proptest_exclusion.py` pins the default
invocation (`pytest -q` with no `-m`) against this regressing silently; it
cannot pin every possible custom `-m` a future command might use.

## What each property checks

Both run in-process against a fresh app and a fresh copy of a seeded
template database per Hypothesis example. A state machine's `__init__`
builds its own copy, rather than using a fixture: Hypothesis runs many
examples inside one pytest test, and a function-scoped fixture would be
shared across them. `time-machine` freezes the clock (`FROZEN_NOW`), so
conflict notes land on a known daily page that the generators never
otherwise address.

| Property | Drives | Against | Invariants |
|---|---|---|---|
| `test_ops_state.py` (`OpsMachine`, a `RuleBasedStateMachine`) | random `OpBatch`es through `POST /api/ops`, plus batch replay and batch-id reuse | `props/model.py`, a second implementation written from `backend.md` and `sync-and-offline.md`, not from `ops_core` | every pool block's `(page, parent_uid, order_idx, text, heading, collapsed, view_type)` matches the model; unique sibling keys; a well-formed tree; replay is byte-for-byte inert; reuse is a 409; every conflict-table text is kept under a `[[conflict]]` header; `refs`/`block_refs` match the extractor; the ack's `applied`/`skipped` match the model |
| `test_planner_props.py` (`test_cli_batch_positions`) | a random `pkm batch` command list, run through the real CLI shell (`pkm.client.workflows.apply_batch`) against a seeded page | `props.model.positions_after`, a list-based reference for the `index` contract in [cli-and-mcp.md § Pure planners](cli-and-mcp.md#pure-planners) | sibling order matches the reference, except in groups a skipped op (cycle move, missing uid/parent, or a simulated concurrent delete) could legitimately leave off it; unique sibling keys; a well-formed tree |

The reference model must never import `ops_core`, `ops_apply` or `planning`
(`test_model.py` pins this): it has to actually encode the documented
semantics, not re-derive the server's own decisions, or a server bug and its
model would agree by construction.

## Reading a failure

Hypothesis shrinks a failure to the smallest batch that reproduces it, then
prints it with `print_blob=True`'s `@reproduce_failure(...)` decorator. Paste
that decorator onto the failing test and re-run it under `HYPOTHESIS_PROFILE=merge`
to replay exactly that example without re-exploring. The example database at
`server/.hypothesis/` (gitignored) also means a bare re-run of the same test
tries that recent failure first, decorator or not.

A property failure blocks the merge:

- Read the shrunk example and decide whether it is a product bug or a wrong
  property.
- A product bug gets fixed with the shrunk example added as an ordinary unit
  test in `server/tests/` (not `props/`) — the gate stays an explorer, the
  regression lives where it runs on every commit.
- A wrong property gets fixed in `props/`, with the commit message saying why.
- Arthur may accept a failure instead, with a bean filed.

A property that fails once and passes on a re-run of the same seed is a
harness bug (flaky), not a product one: file a bean against the gate and
carry on, the same as perf's "unstable".

## Calibration

`props/harness.py`'s `MERGE_EXAMPLES` sets each property's `max_examples`
under the `merge` profile, sized so `proptest/check.sh server` runs in about
3 minutes. `examples()` caps every other profile (`dev`'s default) at 20, so
running a props file by hand stays fast.

```
HYPOTHESIS_PROFILE=merge uv run pytest -m proptest --no-cov -q tests/props \
  --hypothesis-show-statistics
```

This prints each generator's `event()` counts: what fraction of examples hit
each branch. A generator that stops reaching its interesting cases — a
changed rate, a widened uid pool — shows up as a shifted percentage rather
than a silent loss of coverage.
