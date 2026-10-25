# Breadcrumbs Ancestor Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backlink and block breadcrumbs cost work linear in the distinct
ancestors read, not cubic in depth, with byte-identical output.

**Architecture:** `routes_pages._fetch_ancestors` runs one recursive CTE per
chunk of start uids, and each CTE row carries the path string of every uid
above it, so a chain of `d` blocks that all link the target yields `d²/2`
rows, each building and searching an `O(d)` string. The rewrite walks
`blocks` upward with a `UNION` (not `UNION ALL`) CTE over `uid` alone:
SQLite adds a row to the recursion queue only when it has not been added
before, so each distinct ancestor is read once and a parent cycle ends the
walk. A pure function then rebuilds each start's root-first trail from the
`uid -> (parent_uid, text)` map, stopping at the first uid already on that
trail, which is the old `instr(path, …)` rule.

**Tech Stack:** Python 3, SQLite recursive CTEs, FastAPI, pytest +
Hypothesis, `perf/check.sh` (`server/tooling/perfcheck`).

**Spec:** the bean `.beans/pkm-85jq--backlink-breadcrumbs-cost-odepth3.md`
and the finding "A deep chain of blocks each linking the target" in
`docs/security-review-2026-10-23.md`; the probe is
`docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-pages/p8_ancestors.py`
(gitignored).

## Global Constraints

- Same output: for every start uid, the same list of ancestor texts,
  root first; starts with no ancestors (or not in `blocks`) absent from the
  dict.
- No depth bound. `test_hardening.py` pins complete breadcrumbs past
  `MAX_OUTLINE_DEPTH` (legacy data predates the cap), so termination on a
  cycle comes from `UNION` dedup, not a depth limit.
- Still chunked by `sync_core.chunk_ids` (SQLite variable limit).
- One SQL statement per chunk, as now (the perf gate counts statements).
- `routes_pages.py` stays Imperative Shell; the trail walk is Functional
  Core in `server/tree.py`.

## Decisions

- **Why not a depth bound (`MAX_OUTLINE_DEPTH`)?** It truncates real chains
  deeper than the cap, which exist in pre-cap data and which
  `test_block_ancestor_breadcrumbs_are_complete_for_deep_linear_chain`
  pins at 150. It would also loop a cycle until the bound, emitting repeated
  texts, so the walk would still need a seen-set in Python.
- **Why `uid` alone in the CTE?** `UNION` dedups whole rows; a row of
  `(start_uid, uid, depth)` never repeats, so it would not end a cycle.
  Without `start_uid`, starts that share ancestors also share their rows.
- **Perf case without touching `fixture.py`.** `fixture_hash` hashes
  `fixture.py`, and the frontend baseline shares it, so changing the
  fixture would rebaseline every scenario on both sides. Instead a backend
  scenario carries a `seed` batch POSTed (untraced, untimed) to a fresh
  fixture copy before each run. The chain is built through `/api/ops`, so
  its depth is the outline cap: the deepest shape a client can make now.
  The deep probe shapes (250 to 2,000) are measured once, outside the gate.

## Review Focus

- A parent cycle reached from a start (a chain that runs into a loop, a
  self-parent): the walk must terminate and stop at the repeat, as before.
- A dangling `parent_uid` (parent row gone): the trail ends at the last
  existing block.
- Starts that share ancestors, or a start that is another start's ancestor.
- A start uid that is not in `blocks`, and duplicate start uids.
- Starts split across two chunks whose ancestors were read by the other
  chunk.

---

### Task 1: Perf case for deep breadcrumbs (old query)

**Files:**
- Modify: `server/tooling/perfcheck/backend.py` (`Scenario`, `scenarios`,
  `_guard_dirty`)
- Modify: `perf/baseline-backend.json` (written by the check)

**Interfaces:**
- Produces: scenario `page/deep-backlinks`: `GET /api/page/Perf Deep
  Target` after a seed batch creating `Perf Deep Chain`, a chain of blocks
  each one the child of the last, every text `[[Perf Deep Target]]`, as
  deep as `/api/ops` allows.

- [ ] **Step 1:** Add `seed: dict | None = None` to `Scenario` (an op
  batch). `_guard_dirty` treats `s.writes or s.seed` as needing
  `env.fresh()`, then POSTs the seed to `/api/ops` (raise on non-200) and
  marks the env dirty. List the scenario after the write scenarios.
- [ ] **Step 2:** Confirm the chain depth `/api/ops` accepts (one more
  level is a 400) and fix the seed's length to it.
- [ ] **Step 3:** `perf/check.sh backend` on the old query; expect the
  scenario reported `new` and recorded, every other scenario passing.
- [ ] **Step 4:** Commit `backend.py` and `perf/baseline-backend.json`.

### Task 2: Equivalence and work tests (red)

**Files:**
- Create: `server/tests/test_ancestor_walk.py`

**Interfaces:**
- Consumes: `routes_pages._fetch_ancestors(db, uids) ->
  dict[BlockUid, list[str]]`
- Produces (Task 3 implements): `tree.ancestor_texts(starts:
  Sequence[BlockUid], blocks: Mapping[BlockUid, tuple[BlockUid | None,
  str]]) -> dict[BlockUid, list[str]]`

- [ ] **Step 1:** Keep the old CTE verbatim in the test as the oracle
  (`_reference_fetch_ancestors`).
- [ ] **Step 2:** Hypothesis property
  `test_fetch_ancestors_matches_the_path_string_walk`: random graphs of up
  to 12 blocks where each parent is none, any block (self included, so
  cycles), or a missing uid (foreign keys off); random starts including
  duplicates and an unknown uid; chunk size patched small so starts split
  across chunks. Assert `_fetch_ancestors == _reference_fetch_ancestors`.
  Events: cycle, dangling parent, shared ancestor, split chunk.
- [ ] **Step 3:** Fixed cases at the outline cap: a chain of
  `MAX_OUTLINE_DEPTH + 1` blocks, every block a start; the same chain whose
  root's parent is its leaf (a cycle of that length); equal to the oracle.
- [ ] **Step 4:** `test_ancestor_query_work_is_linear_in_depth`: VM steps
  (progress handler) for every block of a chain of depth 200 versus 400;
  doubling the depth must less than triple the steps (old: about 4x).
- [ ] **Step 5:** Unit tests of `ancestor_texts` on a cycle, a self-parent,
  a dangling parent, an unknown start.
- [ ] **Step 6:** Run; expect the work test and `ancestor_texts` tests to
  fail, the equivalence tests to pass on the old code.

### Task 3: The rewrite (green)

**Files:**
- Modify: `server/src/pkm/server/routes_pages.py` (`_fetch_ancestors`,
  delete `_fetch_ancestors_chunk`)
- Modify: `server/src/pkm/server/tree.py` (add `ancestor_texts`)

- [ ] **Step 1:** CTE per chunk:
  `anc(uid)` = the chunk's uids from `blocks`, `UNION` `b.parent_uid`
  joined from `blocks` on `anc.uid` where not null; select `uid,
  parent_uid, text` from `anc JOIN blocks`. Merge every chunk into one map,
  then `ancestor_texts(starts, map)`.
- [ ] **Step 2:** `ancestor_texts`: per start present in the map, follow
  `parent_uid` while the uid is in the map and not yet seen (the start
  counts as seen), collecting texts; reverse; keep only non-empty trails.
- [ ] **Step 3:** Run `test_ancestor_walk.py`, `test_hardening.py`,
  `test_backlinks.py`, `test_sql_variable_limit.py`; expect PASS. Break the
  seen check once and confirm the property fails, then restore.
- [ ] **Step 4:** Measure the probe shape at 100, 250, 500, 1,000, 2,000
  before and after; record in the report.
- [ ] **Step 5:** `perf/check.sh backend`; expect `page/deep-backlinks`
  counts improved (ratcheted) and no regression. Commit code, tests,
  baseline.

### Task 4: Docs and gates

- [ ] **Step 1:** Invoke `architecture-docs`. Add the rule beside the
  breadcrumb read in `docs/architecture/backend.md` (an ancestor walk
  dedups by uid, never carries a per-row path string), and a row under
  Backend in `docs/troubleshooting.md` (symptom, cause, owning section,
  `pkm-85jq`).
- [ ] **Step 2:** `cd server && uv run pytest -q`, `uv run pyrefly check`,
  `uv run ruff check`; logs under `.superpowers/sdd/85jq/`.
- [ ] **Step 3:** Commit docs.
