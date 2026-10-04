# Property checks

`proptest/check.sh` is a property-based gate for the sync and planning
invariants, in two suites:

| Side | Framework | Drives | Compared with |
|---|---|---|---|
| `server` | Hypothesis | random op batches and CLI batches, in-process | a from-the-docs reference model |
| `web` | fast-check | 2 or 3 clients running the real web sync stack against the real server, with faults | the server's state, through an oracle (see [What the web property checks](#what-the-web-property-checks)) |

It runs locally before a merge, the same way
[`perf/check.sh`](performance-checks.md) does; it is not CI, a git hook, or
part of `pytest -q`, `pnpm test:unit` or `pnpm verify`.

What to do with a failure is in
[`AGENTS.md` § Testing](../../AGENTS.md#testing). The rationale and rejected
alternatives are in the design specs:
[server](../superpowers/specs/2026-10-02-property-checks-server-design.md) and
[web sync harness](../superpowers/specs/2026-10-03-property-checks-sync-harness-design.md).

## Running it

```
proptest/check.sh [auto|server|web] [--seed N] [--path P] [--replay-path R]
```

`auto` (the default) picks sides from the diff against `main`, the same rule
as `perf/check.sh`:

| Changed path | Side |
|---|---|
| `server/…` | server |
| `web/…`, except `web/e2e/` and `*.md` | web |
| `server/src/…`, `server/tooling/proptest/sync_server.py` | web as well: the web suite drives the real server's sync routes |

`--seed N` reproduces a specific run (`--hypothesis-seed=N` on the server
side, fast-check's seed on the web side); without it, each run explores a new
random seed. `--path` and `--replay-path` apply to the web side only
(see [Reading a web failure](#reading-a-web-failure)).

The web side starts the harness server, `server/tooling/proptest/sync_server.py`,
on port 8978, waits for `/healthz`, runs vitest, and stops the server by PID.
It refuses to run when 8978 is already in use. The server is the real
`create_app` plus five control routes the suite needs, which exist only in
that launcher and never in `pkm.server.app`:

| Route | Does |
|---|---|
| `POST /__proptest/reset` | restores the seeded database (six `pt_seed_N` blocks on the `Proptest` page, three `pt_sec_N` blocks on the `Second` page) and the clock |
| `POST /__proptest/clock` | moves the frozen server clock |
| `POST /__proptest/rotate-generation` | rotates the sync `db_generation` |
| `GET /__proptest/applied` | `applied_batches` rows in commit order, with `applied_at` |
| `GET /__proptest/renames` | every page retitle in commit order: the titles, the batch it followed (`after_batch_id`, null before the first) and the clock `at` it ran at. A trigger the seeded database installs writes the log, because a rename is a route of its own, not a batch |

The server clock starts at `START_MS`, 2026-03-01 12:00 Europe/London, never
ticks, and moves only by `/__proptest/clock`. It never moves before `START_MS`
or more than a year past it, because the harness logs in once at `START_MS` and
session cookies are rejected when issued in the future or more than a year ago.

| Module | Pattern | Role |
|---|---|---|
| `proptest/check.sh` | script | wrapper: `TZ=Europe/London`, `python -m proptest.run` |
| `server/tooling/proptest/run.py` | Imperative Shell | git diff; the server runner (`uv run pytest -m proptest --no-cov tests/props` under `HYPOTHESIS_PROFILE=merge`) and the web runner (launches `sync_server.py`, then `vitest run --config vitest.props.config.ts`, passing `PROPTEST_*` environment variables) |
| `server/tooling/proptest/sides.py` | Functional Core | `sides_for(changed_paths)`, mirrors `perfcheck.run_core.sides_for` plus the `server/src/` rule |
| `server/tooling/proptest/sync_server.py` | Imperative Shell | the harness server on port 8978 |
| `web/vitest.props.config.ts` | config | node environment, includes only `src/props/**/*.prop.ts`, one fork, no jsdom setup |
| `web/src/props/sync/env.ts`, `serverControl.ts` | Imperative Shell | the `PROPTEST_*` settings; the session cookie and the control routes |
| `web/src/props/sync/cancel.ts` | Imperative Shell | one example's server handle, which refuses every call once the example is cancelled and aborts any request still on the wire, so an abandoned example cannot reach the server the next one has reset |
| `web/src/props/sync/transport.ts` | Imperative Shell | one client's network to the server: one-shot faults, a window limit, and the deliberately broken modes the teeth tests use |
| `web/src/props/sync/harnessClient.ts` | Imperative Shell | one simulated device: the real replica worker, op queue, replica sync, client runtime, legacy repair and reconnect flow, over an in-memory database that survives `reload()`. The legacy repair's outline sessions are stood in for by one page read through the client's transport, which fails while offline |
| `web/src/props/sync/model.ts`, `arbitraries.ts`, `normalise.ts` | Functional Core | the command model; op drafts and the uid pool; the common graph form replicas and snapshots are compared in |
| `web/src/props/sync/commands.ts` | Imperative Shell | one fast-check command class per row of the commands table below |
| `web/src/props/sync/oracle.ts`, `quiesce.ts` | Imperative Shell | the six invariants; bringing every client to rest |
| `web/src/props/sync/sync.prop.ts` | Imperative Shell | the property, the seventeen fixed scenarios, the tally |
| `web/src/props/sync/teeth.prop.ts`, `harness.prop.ts`, `smoke.prop.ts` | test | the oracle's teeth; the harness client and transport self-tests; the server wiring |
| `web/src/props/sync/normalise.test.ts`, `arbitraries.test.ts` | test | unit tests that do run under `pnpm test:unit` |
| `server/tests/props/conftest.py` | test | Hypothesis profiles (`merge`, `dev`), the `template_db` fixture |
| `server/tests/props/harness.py` | test | non-fixture helpers every property needs: `template_db_path`, `fresh_app`, `FROZEN_NOW`, `MERGE_EXAMPLES`, `assert_unique_keys`/`assert_well_formed` |
| `server/tests/props/strategies.py` | Functional Core | uid pools, trees with gapped keys, op and CLI-command strategies |
| `server/tests/props/model.py` | Functional Core | the reference model (below) |
| `server/tests/props/test_ops_state.py`, `test_planner_props.py` | test | the two properties |
| `server/tests/props/test_model.py` | test | unmarked, runs in the normal suite: pins the model's own behaviour |
| `server/tests/props/test_smoke_props.py` | test | pins per-example `template_db` isolation across Hypothesis examples |

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

## What the server properties check

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

## What the web property checks

`sync.prop.ts` starts 2 or 3 clients, equally often, each the real web sync stack
(`harnessClient.ts`), against the harness server. fast-check draws up to 30
commands naming only the clients that example starts (`commandsFor`), runs them, brings every client to rest (`quiesce.ts`), and runs the
oracle. Seventeen fixed scenarios, each a regression the property first found, run
through the same commands.

| Command | Does | Skipped when |
|---|---|---|
| `Edit` | enqueues a batch of op drafts (create, update, move, delete) resolved against the model. A top-level create or move names a page from the title pool, or none. The uid pool spans both seeded pages | the client is not in the example |
| `BadBatch` | enqueues a create of a uid that is live everywhere, which the server rejects with a 400 | a write failure is armed or the in-memory lane is non-empty |
| `Offline` | cuts the client's network and draws its return: back online after 1, 2, 3 or 5 further commands (about three draws in four), or not until quiesce (about one in four). `SyncCommand.run` brings it back; skipped commands do not count. There is no `Online` command | already offline |
| `Fault` | arms one fault: `dropAck` (lose the ack after commit), `duplicate` (send twice), `lostPull` (lose a changes response), `writeFails` (fail the next local write, which pushes ops into the in-memory lane) | `writeFails` already armed |
| `Pull` | forces a catch-up | offline |
| `Nudge` | a websocket `seq` frame: `latest`, `stale`, `duplicate` or `ahead` of the journal | offline |
| `Rename` | a page rename from a fixed title pool (`Proptest`, `Second`, `Third`, `Fourth`) through the client's network, never a merge. Pool titles are never changed by it: a drawn title may name the page it named at the start, another page, or none. The route refusing it (400, 404, 409) or a dead network is a counted outcome, not an error | the client is not in the example |
| `Reload` | a page reload: the worker and in-flight requests die, the database survives. Half the time an online client's new life connects 1 to 7 timer ticks after its mount begins, possibly mid-startup as the app's socket can; otherwise once the startup has finished (`connectTiming`, `HarnessClient.reload`) | ops would be lost by design (a non-empty lane or armed write failure) |
| `RotateGeneration` | rotates `db_generation`, so every client's next pull rebases | never |
| `CrossMidnight` | the server clock to 23:59:55 local, then ten seconds on; one crossing in four lands on a BST/GMT changeover | never |

A skipped command is a precondition failing in the model, not an error. The
tally counts each skip by reason. A client's first start connects on the same
timing as a `Reload` (`StartOptions.connectAt`).

After quiescence `oracle.ts` evaluates every invariant, never stopping at the
first failure, and throws one `OracleError` that names each one that failed.
Cursor monotonic runs after every command instead.

| Invariant | Holds when | Catches |
|---|---|---|
| convergence | each replica's graph equals the server's snapshot | a lost, duplicated or misplaced change on a client; a feed that omits a row a replica needs |
| accounting | `applied_batches` holds exactly the batches the model expects, no rejected batch landed, every rejected batch was reported poisoned, and no pending or poisoned rows remain | a dropped, double-applied or re-id'd batch; a rejection that was never surfaced |
| per-client order | each client's batches landed in its enqueue order | a queue that reorders its own client's delivery |
| desync/poison | no `onDesync`, and `onPoison` only for batches the model expects to be rejected | a recovery path taken for no reason; a valid batch rejected |
| serial replay | replaying the recorded request bodies in commit order, each at its `applied_at`, on a fresh server reproduces the final graph | server-side apply that depends on anything but the batch sequence and the clock |
| cursor monotonic | no client's cursor goes below the highest it has shown, across reloads and recoveries | a cursor rewound by a recovery or a stale frame |

Serial replay puts each page rename back between the two batches it fell
between, at the clock it ran at, using `/__proptest/renames`. A rename that
followed a batch that never applied is itself a finding. The replay resets the
server, so the faulted run's snapshot, applied list and renames are read
first. Ids the server mints are compared by position.

`teeth.prop.ts` checks the oracle can fail. Each broken transport mode
(`dropBatch`, `reidBatch`, `holdBatch`, `skipWindow`) must trip the invariant
that exists for it, a tampered recorded body must trip serial replay, and a
clean run must pass. Serial replay has two more: an omitted rename, and a
rename replayed after the wrong batch, must each trip it, and a run with a
rename must replay clean. If a broken mode passes, the oracle is blind.

One example in three draws a changes-feed window limit of one to five
journal rows, so a catch-up crosses window boundaries, where block tombstones
wait for the window at the journal head (see
[sync-and-offline.md § The changes feed](sync-and-offline.md#the-changes-feed)).
The rest run with the server's default window. A fixed scenario also cuts the
window at one row.

## Reading a server failure

Hypothesis shrinks a failure toward the smallest batch that reproduces it,
then prints it with `print_blob=True`'s `@reproduce_failure(...)` decorator.
Shrinking can stop early at Hypothesis's 5-minute cap, so the printed example
is not guaranteed minimal. Paste the decorator onto the failing test
(`test_planner_props.py`'s `@given` test), or onto `OpsMachine` itself or its
`TestOps = OpsMachine.TestCase` (`test_ops_state.py`). Re-run it under
`HYPOTHESIS_PROFILE=merge` to replay exactly that example without
re-exploring; past the cap, this also resumes shrinking from where it left off.
The example database at `server/.hypothesis/` (gitignored) also means a bare
re-run of the same test tries that recent failure first, decorator or not.

## Reading a web failure

A failing run prints one report:

```
sync property failed after N runs and M shrinks
seed: …
path: …
counterexample: <clients>, <command list>
error: <the oracle's findings>
replay: proptest/check.sh web --seed … --path '…' --replay-path '…'
```

The error also carries a transcript of what each command did in the failing
run, with each client's fired faults, and the oracle's evidence per failed
invariant. Run the `replay:` line to re-run just the shrunk example.

A replay is only as deterministic as the run: examples that depend on timing
(a retry timer, a pull overlapping a websocket frame) may not reproduce. A
failure that does not reproduce from its seed is still a finding. Read the
transcript and the invariant, and reproduce the scenario with a fixed command
list (the fixed scenarios in `sync.prop.ts` are the pattern). An example that
runs past 90 seconds fails as a hung command, and one that cannot settle in
30 seconds fails as a liveness failure with each client's state.

## When a property fails

A property failure blocks the merge:

- Read the shrunk example and decide whether it is a product bug or a wrong
  property.
- A product bug gets fixed with the shrunk example added as an ordinary unit
  test on the side the bug is on (pytest in `server/tests/`, vitest beside the
  code under `web/src/`), never in `props/`. The gate stays an explorer; the
  regression lives where it runs on every commit.
- A wrong property gets fixed in `props/`, with the commit message saying why.
- Arthur may accept a failure instead, with a bean filed.

A property that fails once and passes on a re-run of the same seed is a
harness bug (flaky), not a product one: file a bean against the gate and
carry on, the same as perf's "unstable". On the web side, a replay that does
not reproduce is not on its own evidence of a flaky harness (see above).

## Calibration

Each sub-project's suite brings its own budget, so the gate's total grows as
suites are added. Today it is about 3 minutes for the server side and about 3
for the web side. The budget is set where the count is set:

| Side | Count | Sized for |
|---|---|---|
| server | `props/harness.py`'s `MERGE_EXAMPLES` per property, `max_examples` under the `merge` profile | `proptest/check.sh server`, about 3 minutes |
| web | `NUM_RUNS` in `sync.prop.ts` (2100 examples) | `proptest/check.sh web`, about 3 minutes |

### Server

`MERGE_EXAMPLES` sets each property's `max_examples`. `examples()` caps every other profile (`dev`'s default) at 20, so
running a props file by hand stays fast.

```
HYPOTHESIS_PROFILE=merge uv run pytest -m proptest --no-cov -q tests/props \
  --hypothesis-show-statistics
```

This prints each generator's `event()` counts: what fraction of examples hit
each branch. A generator that stops reaching its interesting cases — a
changed rate, a widened uid pool — shows up as a shifted percentage rather
than a silent loss of coverage.

### Web

The property's `afterAll` prints a tally covering every run, shrinks
included: examples per client count and window limit, each command's runs and
each skip by reason, op kinds, and examples with a conflict or a rejected
batch. `Online after k` counts offline periods that ended by their drawn
return, and `Online at quiesce` those that lasted until quiesce (`, before its
return` when the commands ran out first). `start` and `Reload` rows report
where timed connects landed: mid-startup, after startup, offline (the timing
was ignored) or untimed. Fault rows show *armed* beside *fired*. A fault is armed by the
command and fires only if a request meets it, so a large gap means the faults
are not reaching anything. A skip count that climbs means a precondition has
stopped matching what the generator draws. Run `proptest/check.sh web` and
read the tally after any change to the commands, their weights or the
preconditions. The weights themselves are in `commands.ts`'s `commandsFor`.

The property is also bounded, at `PROPERTY_LIMIT_MS` (420 seconds):

| When the limit hits | The run |
|---|---|
| after a failure, while shrinking | fails with the smallest counterexample so far |
| with no failure | fails as "ran out of its time budget", a budget problem and not a finding |

Every example is cancelled when it ends, whether it passed, failed, hung or was
abandoned at the limit, and only then are its clients disposed. A dispose that
fails or hangs is appended to the example's failure, or fails a passing example.
