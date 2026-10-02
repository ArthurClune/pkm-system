# Property checks: gate and server suite (pkm-svgx)

Agreed with Arthur 2026-10-02. First of four sub-projects under the epic
pkm-nws9 (property-based sync checks). The others, each needing its own
spec, are the sync protocol harness (pkm-yxcs), client/server op divergence
(pkm-j3ui) and outline edit commands (pkm-f7zv).

## Problem

Sync correctness rests on example tests plus hand-written parity fixtures.
The batch-index work (pkm-78fk) found its composition bugs only through a
throwaway run of 5000 random cases that nobody kept. Nothing in the repo
explores op sequences systematically, and nothing would notice the next
composition bug.

## Outcome

- `proptest/check.sh` runs a property-based suite before merge, like
  `perf/check.sh`. It takes about 2–4 minutes and never runs on every
  commit: `pytest -q` and `pnpm verify` exclude it.
- This sub-project builds the gate and its server side:
  - stateful op invariants through `/api/ops`;
  - Planner vs server for CLI/MCP batches.
- Every failure the gate finds is fixed with its shrunk example added as an
  ordinary unit test in the normal suite. The gate stays an explorer; the
  regression lives where it runs on every commit.

## The gate

| Piece | Design |
|---|---|
| Library | `hypothesis`, added to the `dev` dependency group in `server/pyproject.toml` |
| Location | `server/tests/props/`, so the suite shares `tests/conftest.py` fixtures and pyrefly/ruff cover it |
| Exclusion | A registered `proptest` marker (`pytestmark` in each props module). `addopts` gains `-m "not proptest"`, so `pytest -q` deselects it |
| Wrapper | `proptest/check.sh [auto\|server\|web] [--seed N]`. It sets `TZ=Europe/London` and runs `uv run pytest -m proptest --no-cov tests/props` under `HYPOTHESIS_PROFILE=merge`. The later `-m` overrides the `addopts` one, and `--no-cov` drops the 95% gate, which a partial run would fail |
| Sides | `auto` picks sides from the diff against the merge base with `main`, the same rule as `perf/check.sh` (`server/…` → server; `web/…` → web). This sub-project ships only `server`; naming `web` exits with "no web properties yet" until pkm-j3ui/pkm-f7zv add them |
| Profile | `tests/props/conftest.py` registers `merge`: `max_examples` set per property so the server side lands at 2–4 minutes on this machine; `deadline=None`; `suppress_health_check=[too_slow]` for the stateful test; `print_blob=True`. A `dev` profile with few examples is the default when you run a props file by hand |
| Seed | Random on every run, so each merge explores new ground. `--seed N` passes `--hypothesis-seed=N` to reproduce a run |
| Failure memory | Hypothesis's example database stays in `server/.hypothesis/` (gitignored), so the next local run replays a recent failure first |
| Exit | Non-zero when any property fails; the output is pytest's, with the shrunk example and `@reproduce_failure` blob |

What a failure means, beside the perf verdicts in AGENTS.md § Testing:
- A **property failure** blocks the merge.
  - Read the shrunk example and decide whether it is a product bug or a
    wrong property.
  - A product bug gets fixed with the example as a unit test in
    `server/tests/` (not `props/`).
  - A wrong property gets fixed in `props/`, and the commit message says
    why.
  - Arthur may accept a failure instead, with a bean filed.
- A **flaky property** (fails, then passes on the same seed) is a harness
  bug. File a bean against the gate and carry on, as with perf "unstable".

## Server suite

Both properties run in-process against a fresh DB per example. A
session-scoped fixture builds `seeded_config`'s DB once; each example copies
the file into its own temp dir and builds its own app/`TestClient` from that
copy. A state machine's `__init__` does this itself, because Hypothesis runs
many examples inside one pytest test and function-scoped fixtures would be
shared across them. `time-machine` freezes the clock, so conflict notes land on a
known daily page.

### 1. Op invariants (stateful)

`test_ops_state.py`: a `RuleBasedStateMachine` that POSTs random `OpBatch`es
to `/api/ops` through `TestClient`. It goes through the real route, so
dedupe and replay are covered, not just `apply_batch`.

**Generation.** Ops reference uids drawn from a pool. The pool mixes:
- live blocks;
- blocks deleted earlier in the run;
- uids that never existed;
- pages that exist and pages that don't.

The generator covers all eight op types:
- `create`, `move` (including cycle moves), `delete` and `update_text`;
- `set_collapsed`, `set_heading`, `set_view_type` and `create_page`.

`base_text_hash` and `base_subtree_hash` are each one of correct, stale
(the hash of an earlier text) or absent. Batches hold 1–20 ops. An op the
server rejects outright (a 400 `OpError`) is a legitimate outcome. The model
then expects no state change, and the machine checks that the server made
none.

**Rules:**
- **submit:** a new batch.
- **replay:** resend an earlier batch with the same id and payload.
- **reuse:** send a different payload under an earlier batch's id.

**Reference model** (`props/model.py`, pure). It applies the documented
semantics in the most direct form, with no SQL:
- per-sibling-group lists of `(uid, order_idx)`;
- `ShiftSiblings`/`SetParent` arithmetic;
- the missing-target table in `backend.md § Missing targets`;
- the conflict table in `sync-and-offline.md § Conflicts at push time`.

It is deliberately a second implementation, written from the docs rather
than from `ops_core`. Where it disagrees with the server, either the code or
the doc is wrong.

**Invariants**, checked after every rule:

| Invariant | Check |
|---|---|
| Model agreement | Every block's `(page, parent_uid, order_idx, text, heading, collapsed, view_type)` equals the model's |
| Unique sibling keys | No two siblings share an `order_idx` (the schema doesn't enforce it) |
| Well-formed tree | Every `parent_uid` exists on the same page; no cycles; every block reaches a page root |
| Replay is inert | **replay** returns the stored ack byte-for-byte and changes nothing, including the `changes` journal |
| Reuse is refused | **reuse** gets 409 and changes nothing |
| No text lost | Every text the conflict table says is kept (an overwritten text, an edit to a deleted block, a deleted-while-edited subtree) is the text of some block under a `[[conflict]]` header on the frozen day's daily page |
| Derived refs | `refs` and `block_refs` equal what the `reindex_*` parsers derive from the current texts |
| Ack accounting | `applied == len(ops)`; `skipped` lists exactly the ops the model skipped |

### 2. Planner vs server

`test_planner_props.py`: this generalises the 5000 throwaway cases.

**Generation:**
- A page with random nesting and gapped `order_idx` keys, since prod has
  gaps in about 2% of sibling groups.
- A random CLI batch of:
  - `create`/`todo`, with and without `index`, including past the end;
  - `move`, with and without `index`, within and across parents and onto
    its own slot;
  - `delete`;
  - parents created earlier in the same batch.

**Run:**
1. Seed the page.
2. `plan_batch`.
3. `apply_batch`.
4. Read the page back.

**Invariants:**

| Invariant | Check |
|---|---|
| Planner model = server | The planner's sibling model after planning gives the same per-parent child order as the DB |
| Position semantics | That order equals a list-based reference: `index` is a 0-based position among the parent's current children as earlier commands left them; past the end appends; an indexed move lands at its final position among the destination's children without the moving block |
| Unique sibling keys, well-formed tree | As in property 1 |

**The planner's known limit.** It doesn't simulate an op the server skips:
a cycle move, a missing uid or a missing parent. Those commands are still
generated, and the test asserts the documented behaviour:
- the server skips the op and the ack lists it;
- the planner's model then disagrees, but only for that op's sibling
  groups.

The test doesn't filter these cases out.

## Files

| File | Pattern | Role |
|---|---|---|
| `proptest/check.sh` | script | the wrapper |
| `server/tooling/proptest/sides.py` | Functional Core | `sides_for(changed_paths)`. It mirrors `perfcheck.run_core.sides_for` rather than importing it, so the gates stay separable |
| `server/tooling/proptest/run.py` | Imperative Shell | git diff, then exec pytest per side |
| `server/tests/props/conftest.py` | test | profiles, template-DB fixture, frozen clock |
| `server/tests/props/strategies.py` | test | uid pools, trees with gapped keys, op and command strategies; reused by pkm-j3ui |
| `server/tests/props/model.py` | test | the reference model |
| `server/tests/props/test_ops_state.py`, `test_planner_props.py` | test | the two properties |
| `docs/architecture/property-checks.md` | doc | what the gate runs, how to read a failure; linked from `overview.md` |
| `AGENTS.md` § Testing | doc | one bullet beside `perf/check.sh`: when to run it and the failure policy above |

## Testing the gate

- **`sides_for`:** unit tests in the normal suite.
- **Exclusion:** a normal-suite test asserts that a `-m "not proptest"`
  collection of `tests/props` deselects everything, so `pytest -q` can't
  quietly start running it.
- **Mutation probes:** each property must catch, within its `merge` budget,
  a mutation planted by hand. The plan lists them, for example:
  - drop the `ShiftSiblings` in a create;
  - skip the cycle check;
  - store a replayed ack with a fresh `ts`;
  - put back `OrderIdx(p.index)` in `batch.py`.

  They are recorded in the final review, not committed.
- **Timing:** the plan records the measured run time and sets
  `max_examples` from it.

## Out of scope

- The web side of the gate (pkm-j3ui, pkm-f7zv).
- The protocol harness against a real server (pkm-yxcs).
- CI or a git hook: the gate is manual, before merge, like perf.
- A committed corpus of failing seeds: the unit test written with each fix
  is the corpus.
