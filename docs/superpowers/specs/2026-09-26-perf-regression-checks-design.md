# Performance regression checks — design

Date: 2026-09-26 · Status: implemented (plan: `docs/superpowers/plans/2026-09-26-perf-regression-checks.md`; bean pkm-q1hh)

## Intent

Every change is checked for performance regressions against a committed
baseline before it goes to human review: backend checks after any server, DB
or API change, frontend checks after any `web/` change. A regression is first
reviewed by the session that caused it — read the changed code, look for the
cause, fix it — and only reaches Arthur if it survives that. Improvements
ratchet the baseline down so they can't silently erode later.

What Arthur said vs what this design assumes:

| Said | Assumed (confirmed during brainstorming) |
|---|---|
| Backend check after backend/db/api changes; frontend after frontend changes | Runs locally on this Mac as part of verification, not CI |
| Baseline first | Baselines are committed and move only via the compare rules below |
| Regressions get reviewed — session reviews its changed code and looks for improvements before pushing to human review | A regression flags, it does not hard-block a commit |
| Exact match is too strict; improvements update the baseline | Only worsening is a regression; improvement rewrites the baseline |
| Search is a key place slowdowns creep in | Search gets several scenarios on each side, not one |

## Non-goals

- Not CI, not a git hook, not part of `pytest` or `pnpm verify` (prod-scale
  seeding would slow every run and fight the coverage gate).
- Not a replacement for the investigation harness in `web/tooling/perf/`
  (headed runs, `cpu%`, `ws-probe`, scenarios C/D/E stay as they are).
- Bundle size is not tracked here: `web/tooling/budgets.json` already fails
  the build.

## Shape

```mermaid
flowchart LR
  G[fixture.py<br/>seed → ops] -->|ops_apply path| DB[(cached fixture DB<br/>keyed by generator+DDL+product hash)]
  DB --> BE[backend check<br/>TestClient in-process]
  DB --> SV[e2e_serve.py --from-db<br/>port 8977]
  SV --> FE[frontend check<br/>check.mjs, headless]
  BE --> RB[perf/out/result-backend.json]
  FE --> RF[perf/out/result-frontend.json]
  RB & RF --> CMP[compare.py]
  BL[(perf/baseline-*.json<br/>committed)] --> CMP
  CMP --> T[markdown table + exit code<br/>+ rewritten baseline on improvement]
```

## Components

| Unit | Location | Pattern | Does |
|---|---|---|---|
| Fixture generator | `server/tooling/perfcheck/fixture.py` | Functional Core | Pure `generate(seed, scale)`: ops batches, assets, sidebar and landmarks; deterministic prod-shaped graph |
| Fixture builder | `server/tooling/perfcheck/build.py` | Imperative Shell | Applies ops through the real ops-apply path into a DB under a gitignored cache dir (`~/.cache/pkm-perf`), reused while the cache key matches; owns the cache lock and pruning |
| Backend check | `server/tooling/perfcheck/backend.py` | Imperative Shell | Copies the cached DB, runs the scenario list via `TestClient`, writes `perf/out/result-backend.json` |
| Statement counter | `server/tooling/perfcheck/trace.py` (+ `sqlplan.py`) | Imperative Shell (+ Core) | Installs `set_trace_callback` on every connection the app opens for the duration of one request; collects distinct statements for `EXPLAIN QUERY PLAN`, which `sqlplan.py` reads for full scans |
| Frontend check | `web/tooling/perf/check.mjs` | script | Runs the gated scenario subset headless, writes `perf/out/result-frontend.json`; shares extracted helpers (`harness.mjs`) with `perf.mjs` |
| e2e server option | `server/tests/e2e_serve.py` | Imperative Shell | Env options: start from a copy of a given DB, a frozen clock, another `web/dist`, a separate error log, an instance token echoed on `/healthz` |
| Compare | `server/tooling/perfcheck/compare.py` | Functional Core | Applies the rules below to one result vs one baseline; confirmation; bootstrap; the table |
| Orchestration decisions | `server/tooling/perfcheck/run_core.py` | Functional Core | Sides from the diff, re-run groups, exit code, "next" lines, which cache entries to prune |
| Orchestration | `server/tooling/perfcheck/run.py` | Imperative Shell | Picks sides from the diff, builds the SPA when `web/` changed, runs checks, runs compare, confirms, manages merge-base worktrees |
| Entry point | `perf/check.sh [backend\|frontend\|auto]` | script | Short wrapper: `python -m perfcheck.run` |
| Baselines | `perf/baseline-backend.json`, `perf/baseline-frontend.json` | data | Committed |
| Replica-ready mark | SPA (`web/src/…`) | Imperative Shell | `performance.mark("pkm:replica-ready")`, so the frontend check can time replica readiness (no DOM signal exists today) |

Result and baseline files share one shape. Every metric carries its class
(see Determinism); a `band` metric stores the min and max seen at bootstrap,
the others a single value:

```json
{
  "commit": "630e4c8",
  "fixture_hash": "…",
  "env": {"python": "3.12.8", "sqlite": "3.47.2", "chromium": "131.0.6778.33"},
  "scenarios": {
    "backlinks/hub": {
      "statements":          {"class": "exact",  "value": 4},
      "trigger_statements":  {"class": "exact",  "value": 0},
      "vm_steps_k":          {"class": "exact",  "value": 7},
      "bytes":               {"class": "exact",  "value": 18433},
      "full_scans":          {"class": "exact",  "value": 0},
      "median_ms":           {"class": "timing", "value": 11.2}
    },
    "F/typing": {
      "forced_layouts_per_key": {"class": "exact", "value": 1},
      "long_tasks":             {"class": "band",  "min": 0, "max": 2}
    }
  }
}
```

A result file has the same shape, `class` included on every metric — compare
needs the class to know how to judge a metric that's new since the baseline
was recorded. `env` is empty for the side it doesn't apply to (no `chromium`
in the backend file). Node is not part of `env`: it only drives Playwright,
so the frontend result carries it as a top-level field for information.

## Fixture

Deterministic from a seed; shaped after prod (2026-09-26: ~56k blocks, 4.4k
pages, largest page 1,222 blocks):

- ~50k blocks over ~4k pages; one ~1,200-block page; a spread of mid-size pages
- 365 journal days
- `[[links]]`, `#tags`, `((block refs))`, TODOs at plausible rates
- a handful of hub pages with hundreds of backlinks
- text vocabulary chosen so search has common terms (hundreds of hits), rare
  terms (a few), prefix-able words, and phrases

No prod content is read or copied; nothing personal enters the repo.

Two different keys, on purpose:

- **Cache key** = hash of generator source + `pkm.schema.DDL` + the product
  source (`server/src/pkm`, as imported by the run: a merge-base run hashes
  the base's). Decides when the cached DB is rebuilt. The product source is
  in it because the write path fills derived tables in Python (`refs`,
  `block_refs` via `store.reindex_refs_for_text`), not only by triggers, so
  a change there must rebuild the fixture rather than read rows another
  commit wrote.
- **`fixture_hash`** (in result/baseline files) = hash of generator source
  only. Decides whether two runs are comparable. A schema or query change
  keeps the same `fixture_hash`, so it is measured against the baseline —
  which is the point: schema changes are prime regression sources.

The cache dir is shared by every worktree and session on the machine.
Builds happen under an exclusive lock in it, each use marks the fixture as
used, and fixtures unused for about a week (plus temp DBs a killed build
left) are pruned under the same lock. The backend check opens the cached
fixture read-only and writes only private copies.

## Scenarios

### Backend (in-process, one warm-up then N timed repeats)

| Area | Scenarios |
|---|---|
| Pages | big page, hub page, journal day, journal window |
| Links | backlinks on a hub, unlinked refs, `block-refs` |
| Search | common term, rare term, prefix, phrase, many-hit term, title-heavy match, asset-search filters |
| Lists | titles, todos, changed, query, sidebar |
| Sync | snapshot, changes since N |
| Writes | ops batch: 1 edit, 50-op paste, move subtree; rename a hub page |

Each write scenario runs against a fresh copy of the fixture DB.

Per scenario — counts: SQL statements executed, trigger statements executed,
`vm_steps_k` (SQLite VM instructions, in thousands, via a progress handler
firing every 1,000 steps — Python's sqlite3 can't count rows scanned
cheaply, and this catches a full scan or a lost index deterministically),
response bytes, full-table scans (`SCAN <table>` without an index in
`EXPLAIN QUERY PLAN` of any distinct statement). Timing: median wall time.

### Frontend (headless, fixture DB served on 8977)

| Id | Scenario | Counts | Timing |
|---|---|---|---|
| H | cold load, empty replica | requests, API bytes (`/api/*` encodedBodySize), snapshot pages pulled | replica ready |
| H' | warm load (replica + SW warm) | requests, `/api/sync/changes` pulls | first outline paint |
| A/B | idle on big page / journal | timers armed, fetches, WS opens, long tasks | — |
| F | typing on big page | forced layouts, DOM mutations outside the block, `/api` requests over the whole typing run (the one debounced save, its follow-up pulls and the `GET /api/page` refetch, with the order of the save's WS nudge and HTTP ack fixed by the harness) | — |
| J | journal all days mounted, typing | React commits, re-rendered fibers (per keystroke) | — |
| I | journal scroll | `GET /api/page` per day | — |
| K | outline drag on the large page | commits/s, forced layouts | dragover handler time |
| S | top-bar search: type → results → arrow → open | fetches per query, commits per keystroke | keystroke to results rendered |

## Compare rules

| Change vs baseline | Verdict |
|---|---|
| `exact` metric goes up | candidate regression → confirmation (below) |
| `band` metric goes above `max` | candidate regression → confirmation |
| `timing` metric more than doubles | candidate regression → confirmation |
| `exact` metric goes down; `band` value below `min` | improvement: baseline rewritten (`value`, or `min` lowered to the new value; `max` stays) |
| `timing` metric more than halves | improvement: baseline rewritten to the new value |
| `band` value inside `[min, max]`; `timing` metric changed but not past doubling or halving | pass, baseline unchanged |
| New scenario or metric | recorded; new metrics start as `exact` unless the check declares otherwise |
| Scenario missing from the result | lost coverage (regression, no confirmation needed) |
| A metric's class differs from the baseline's | reclassified: needs `--bootstrap` — compare doesn't guess a band from one run |
| `fixture_hash` or `env` differs from baseline | refuse to compare: `perf/check.sh --rebaseline` re-records the baseline at the merge base (temporary worktree, branch's generator, this machine's env), then compare |

Timing improvements ratchet only past the halving line, not on any decrease:
rewriting the baseline on every faster run would walk it down to the
luckiest run seen and turn ordinary noise into future flags. A band widens
downward for the same reason: a low reading lowers `min` but never `max`,
since shifting the whole band down on one lucky run would make the next
ordinary run a candidate; only `--bootstrap` lowers `max`.

**Confirmation.** A candidate regression is only reported as a regression
after two further checks, both run automatically by `check.sh` on the
affected scenarios only (backend: the candidate scenarios; frontend: every
scenario in each candidate's shared browser context — H,W / A,B,F,I /
J,K,S — since counts were recorded in that company, then filtered back to
the candidates):

1. **Re-run on the branch.** If the re-run returns a value the baseline
   accepts, the metric is reported as **unstable** — a harness defect, not a
   code regression. It does not trigger code review; it is fixed as in
   Determinism step 2 (bean against the harness).
2. **Run at the merge base.** For counts: if the merge base now also shows
   the worse value, the baseline is stale for a reason outside the change
   (an env difference the version check missed, a dependency lock bump
   already on main). Reported as **stale baseline**: re-record at the merge
   base, then compare again. For timings, which move with machine load that
   the re-run shares, the branch re-run is judged against the merge-base
   run from the same confirmation: clearly slower than the base (past the
   same doubling line) is a regression; otherwise, if the base itself is
   now worse than the baseline, **stale baseline**; otherwise **unstable**.

Only a value that is worse, reproduces on re-run, and is absent at the merge
base (for a timing: clearly worse than the merge base measured alongside it)
is a **regression**, and only a regression triggers the self-review loop.

Merge-base worktrees live in the cache dir, are created and built under its
lock, marked on each use, and removed (`git worktree remove`, then
`git worktree prune`) once unused for about a week.

Exit code non-zero on regression, unstable metric, lost coverage or stale
baseline; the output says which. Output is a markdown table naming
scenario, metric, baseline, now — e.g. `backlinks/hub  statements  4 → 204`.
The doubling threshold lives in `compare.py` as a named constant; prose in
skills and `AGENTS.md` describes the rule qualitatively (a timing that
clearly worsened, not noise), not the number.

## Workflow

```mermaid
flowchart TD
  D[change done, tests green] --> W{perf/check.sh auto}
  W --> C[compare vs committed baseline]
  C -->|candidate| CF{confirm:<br/>re-run, then merge base}
  CF -->|re-run passes| X[unstable metric:<br/>bean against the harness,<br/>not a code change]
  CF -->|merge base also worse| S[stale baseline:<br/>rebaseline at merge base] --> C
  CF -->|confirmed| R
  C -->|no regression| U[commit any baseline improvements with the change] --> Done[review / push]
  R[self-review: read the diff along the regressed path,<br/>find the cause, fix] --> C2[re-run]
  C2 -->|fixed| U
  C2 -->|still worse| H[stop: table + findings to Arthur]
  H -->|accepted| A[re-record baseline;<br/>reason in commit message] --> Done
  H -->|rejected| R
```

Side selection for `auto` uses `git diff --name-only main`: `server/`,
schema or contracts paths → backend; `web/` → frontend, except `web/e2e/`
specs and `*.md` files, which don't change what the browser runs; both when
both match.

Wiring:

- `AGENTS.md` Testing section: a short rule — run `perf/check.sh auto` before
  considering a change verified; on regression, review your own change first
  and only then escalate.
- `/verify` skill: a "Performance" section with the recipe and how to read
  the table.
- SDD final whole-branch review: the perf table must be present in the
  review package.
- `web/tooling/perf/README.md`: note check mode and that `baselines/` there
  is investigation history, not the gate.

## Determinism

A count that differs between two runs of the same commit says nothing about
the code, so it must never send a session into reviewing an innocent change.
Every metric has one of three classes:

| Class | Meaning | Flagged when |
|---|---|---|
| `exact` | identical on every run of a commit | it goes up |
| `band` | inherently scheduler-dependent, but bounded (e.g. long tasks) | it exceeds the max seen at bootstrap |
| `timing` | wall time | it clearly worsens (more than doubles) |

Reconciliation when runs of one commit disagree:

1. **Detect.** Bootstrap runs each check several times on one commit; any
   metric not identical across all runs is marked unstable.
2. **Fix the source first.** Most instability is an uncontrolled input, and
   the harness removes it:

   | Source | Example | Harness fix |
   |---|---|---|
   | Wall clock / "today" | journal window, `changed`, GET on today's daily creating a page | frozen clock: fixture dates relative to a fixed "now" the server is started with |
   | Background workers | describe worker or goodlinks queries caught by the trace callback | app started with those services disabled or faked, as the tests do |
   | First-request setup | schema checks, caches warming | warm-up run excluded; check asserts warm-up and first timed run agree |
   | Fixed wall-time windows | "fetches during 30 s idle" with a periodic timer landing either side of the edge | count per event (per keystroke, per reconnect) or run to quiescence |
   | Debounce / batching races | commits per keystroke varying with typing speed vs the 500 ms debounce | fixed pace well clear of the debounce, or wait for idle between steps |
   | Message-order races | a save's WS seq nudge and HTTP ack arriving together, deciding whether the replica pulls a window once or twice | harness fixes the order (holds one message with `page.route`) so every run takes the same path |

3. **Only if inherent, reclassify** as `band` (keeps a bound, so a
   jump from 2 to 50 is still caught). Dropping a metric is the last
   resort and is recorded in the check's source with the reason.

The class of each metric is declared in the check script, not inferred at
compare time, so a reclassification is a reviewed code change.

## Bootstrapping

1. Build the fixture and both check scripts with the harness fixes above
   in place from the start.
2. Run each check several times at current `main`; reconcile every unstable
   metric per Determinism until each is `exact`, `band` or `timing` and a
   repeat bootstrap agrees.
3. Record the baselines (with `env`) and commit them.
4. Acceptance: two further runs on the same commit both report pass — no
   regression, no improvement, no unstable metric.

A missing baseline file triggers this bootstrap path (`check.sh
--bootstrap`); a plain check never writes a first baseline from a single
run.

## Errors

- Server fails to boot / scenario throws → the check fails loudly naming the
  scenario; it never writes a partial result file.
- Another perf check running its frontend side → wait for its lock (in the
  cache dir), saying so; fail naming the lock if it is held too long.
- Port 8977 in use by anything else → fail with the port named; never fall
  back to 8974/8975. The port is checked right before the server starts, and
  the server answering `/healthz` must echo the instance token this run gave
  it, so a check never measures another process's server.
- Fixture server output goes to `perf/out/fixture-server.log` (and its
  unhandled-exception log to `perf/out/`, never `web/e2e/.server.log`); the
  tail is printed when the frontend run fails.
- Missing baseline file → fail, pointing at `check.sh --bootstrap`.

## Testing

- `compare.py` (core): unit tests for every row of the compare-rules
  table, each metric class, and each confirmation outcome (unstable, stale
  baseline, confirmed), with the re-run and merge-base runs passed in as
  data so the core stays pure.
- `fixture.py` (core): same seed → identical ops; shape assertions (block
  count range, hub backlink counts, largest page size).
- `trace.py`: a test that a known route's statement count is captured.
- The perf tooling lives outside `server/src`, so it doesn't count toward
  the 95 % coverage gate; its tests run under `server/tests` like the rest.
