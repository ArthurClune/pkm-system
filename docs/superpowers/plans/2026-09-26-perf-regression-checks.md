# Performance Regression Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `perf/check.sh` command that measures backend and frontend performance against a prod-scale synthetic fixture, compares deterministic counts (and clearly-worsened timings) to committed baselines, ratchets improvements into the baseline, and only reports a regression that reproduces and is absent at the merge base.

**Architecture:** A pure Python package `perfcheck` (under `server/tooling/`) holds the fixture generator, the compare/confirm/bootstrap logic and side selection as Functional Core modules; thin shells build the cached fixture DB, run the in-process backend scenarios with a SQL tracer, and orchestrate the frontend check (a new `web/tooling/perf/check.mjs` sharing helpers with the existing `perf.mjs`). Merge-base runs use the *branch's* harness against the *merge base's* product code, in a cached git worktree.

**Tech Stack:** Python 3.12, FastAPI `TestClient`, sqlite3 (`set_trace_callback`, `set_progress_handler`, `EXPLAIN QUERY PLAN`), `time-machine` (new dev dependency), pytest; Node + Playwright (`@playwright/test` ^1.61, `page.clock`), the existing `instrument.js` / `react-commits.js` payloads.

**Spec:** `docs/superpowers/specs/2026-09-26-perf-regression-checks-design.md` (read it first; this plan argues from it).

## Global Constraints

- Never use ports 8974 (prod) or 8975 (`pnpm e2e`). The frontend check's server runs on **8977** only; if 8977 is busy, fail naming the port — no fallback.
- Frozen time for every measured run: **2026-06-15 12:00 Europe/London**; every process runs with `TZ=Europe/London`.
- Fixture seed **1**, scale **1.0** for real runs; tests use scale **0.02**.
- Fixture cache: `${PKM_PERF_CACHE:-~/.cache/pkm-perf}`; never inside the repo.
- Result files go to `perf/out/` (gitignored). Baselines: `perf/baseline-backend.json`, `perf/baseline-frontend.json` (committed).
- Timing threshold is a named constant `TIMING_FACTOR = 2.0` in `perfcheck/compare.py`. Prose in `AGENTS.md` and skills describes the rule qualitatively ("clearly worsened, not noise") and never quotes the number.
- Every new file with runtime behaviour declares `# pattern: Functional Core` or `# pattern: Imperative Shell` (JS: `// pattern: ...`) near the top.
- `perfcheck` lives outside `pkm`, so it is outside the 95 % coverage gate; its tests still live in `server/tests/` and must pass `uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`.
- Never write the phrase "load-bearing" in any doc, comment or skill.
- Commit messages: end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; **never** a `Claude-Session:` trailer or a claude.ai URL (enforced by `.githooks/commit-msg`).
- Work in a worktree on a branch (AGENTS.md). Check `git status -sb` before every commit to be sure you are in the worktree, not the main checkout.

## Spec amendments made while planning

These refine the spec to what the code allows; Task 0 folds them into the spec file.

1. **`rows` → `vm_steps_k`.** Python's sqlite3 cannot count rows scanned cheaply; a progress handler firing every 1,000 VM instructions gives a deterministic "work done" count that catches full scans and lost indexes. Backend counts are `statements`, `trigger_statements`, `vm_steps_k`, `bytes`, `full_scans`.
2. **Result files carry each metric's class** (`{"class": "exact", "value": 4}`), because the class is declared in the check script and compare needs it for new metrics.
3. **Timing improvements ratchet symmetrically:** a timing is only rewritten when it more than halves. Rewriting on any decrease would walk the baseline down to the luckiest run and turn noise into flags.
4. **A metric whose class changed** is reported as `reclassified` and needs `--bootstrap`; compare doesn't guess a band from one run.
5. **Frontend check is `web/tooling/perf/check.mjs`**, sharing extracted helpers (`harness.mjs`) with `perf.mjs`, not a `--check` flag on the 600-line investigation script.
6. **Orchestration is Python** (`perfcheck/run.py`); `perf/check.sh` is a three-line wrapper.
7. **API bytes, not bundle bytes,** in scenario H: every web change alters bundle bytes, and `budgets.json` already gates them.
8. **A `performance.mark("pkm:replica-ready")`** is added to the SPA so the check can time replica readiness; there is no DOM signal for it today.

## Review Focus

1. **Counts that differ between two identical runs** (debounce races, periodic timers crossing a window edge, first-request setup) — a reasonable person expects `--bootstrap` to name the metric and refuse, not write a baseline. Test: Task 1 `test_bootstrap_flags_unequal_exact`; Task 4 `test_counted_runs_agree`.
2. **A schema/DDL change on the branch** — expected to rebuild the cached fixture and still compare against the baseline (same `fixture_hash`). Test: Task 3 `test_cache_key_tracks_ddl_but_fixture_hash_does_not`.
3. **Merge base predates this tooling** (first `--rebaseline` after merging, or an old branch) — expected to work because the branch's harness drives the base's product. Test: Task 7 `test_merge_base_command_uses_branch_harness`.
4. **Port 8977 already taken / server fails to boot** — expected a loud failure naming the cause, never a partial result file. Test: Task 7 `test_port_busy_fails_without_result`.
5. **Uncommitted or untracked files** in the diff — expected side selection to include them (a session runs the check before committing). Test: Task 7 `test_sides_include_untracked`.

---

### Task 0: Worktree, bean, dependencies, skeleton

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-perf-regression-checks-design.md` (fold in the amendments above)
- Modify: `server/pyproject.toml` (dev dep `time-machine`; pytest `pythonpath`)
- Modify: `pyrefly.toml` (`search-path`)
- Modify: `.gitignore`
- Create: `server/tooling/perfcheck/__init__.py`, `perf/.gitkeep`

- [ ] **Step 1: Worktree and bean**

Use `superpowers:using-git-worktrees` to create branch `perf-regression-checks`. Then:

```bash
beans create "Performance regression checks (backend + frontend baselines)" -t feature -s in-progress \
  --body-file docs/superpowers/plans/2026-09-26-perf-regression-checks.md
```
(Run `beans prime` first if not yet done this session. `--body-file` needs a real file, not `-`.) Note the bean id; commits reference it as `perf(<id>): …`.

- [ ] **Step 2: Fold the amendments into the spec**

Edit the spec so it matches "Spec amendments made while planning" 1–8: replace "rows returned" with `vm_steps_k` (and add `trigger_statements`); change the JSON example so result files also carry `class`; change the compare-rules improvement row for timings to "more than halves"; add a `reclassified` row ("class differs from baseline → needs `--bootstrap`"); rename `perf.mjs --check` to `check.mjs` (+ `harness.mjs`) in the Components table; make the entry point `perf/check.sh` → `python -m perfcheck.run`; in scenario H say "API bytes (`/api/*` encodedBodySize)"; add the `pkm:replica-ready` mark to Components.

- [ ] **Step 3: Dependencies and paths**

```bash
cd server && uv add --dev time-machine
```

In `server/pyproject.toml` `[tool.pytest.ini_options]` add:

```toml
pythonpath = ["tooling"]
```

In the root `pyrefly.toml` change `search-path` to:

```toml
search-path = ["server/tests", "server/tooling"]
```

Append to `.gitignore`:

```
# perf check outputs (baselines in perf/ are committed)
perf/out/
```

Create `server/tooling/perfcheck/__init__.py` containing only:

```python
"""Performance regression checks. See docs/superpowers/specs/2026-09-26-perf-regression-checks-design.md."""
```

and an empty `perf/.gitkeep`.

- [ ] **Step 4: Verify the toolchain still passes**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: all pass (no new tests yet).

- [ ] **Step 5: Commit**

```bash
git add .gitignore pyrefly.toml server/pyproject.toml server/uv.lock server/tooling perf docs/superpowers/specs .beans
git commit -m "perf(<id>): scaffold perfcheck package, time-machine dev dep, spec amendments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Compare, confirm and bootstrap core

**Files:**
- Create: `server/tooling/perfcheck/compare.py`
- Test: `server/tests/test_perfcheck_compare.py`

**Interfaces:**
- Produces (used by Tasks 7, 8):
  - `TIMING_FACTOR: float = 2.0`
  - `Finding(scenario: str, metric: str, kind: Kind, baseline: str, now: str)` with `Kind = Literal["candidate", "improvement", "new", "lost", "reclassified"]`
  - `Comparison(findings: tuple[Finding, ...], new_baseline: dict)`, properties `.candidates`, `.blocking` (lost + reclassified)
  - `incomparable_reason(baseline: dict, result: dict) -> str | None`
  - `compare(baseline: dict, result: dict) -> Comparison`
  - `Outcome = Literal["regression", "unstable", "stale-baseline"]`
  - `confirm(baseline: dict, candidates: Iterable[Finding], rerun: dict, merge_base: dict | None) -> dict[tuple[str, str], Outcome]`
  - `Unstable(scenario: str, metric: str, values: tuple[float, ...])`
  - `bootstrap(runs: Sequence[dict]) -> tuple[dict | None, tuple[Unstable, ...]]`
  - `render_table(findings: Iterable[Finding], outcomes: Mapping[tuple[str, str], Outcome]) -> str`
- File shape (both result and baseline): `{"commit": str, "fixture_hash": str, "env": {str: str}, "scenarios": {name: {metric: {"class": ..., "value": n} | {"class": "band", "min": n, "max": n}}}}`. In a **result**, every metric has `value` (band too).

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_perfcheck_compare.py
from perfcheck.compare import (Finding, bootstrap, compare, confirm,
                               incomparable_reason, render_table)


def doc(scenarios, *, fixture_hash="fx1", env=None, commit="c1"):
    return {"commit": commit, "fixture_hash": fixture_hash,
            "env": env or {"python": "3.12.10", "sqlite": "3.47.1"},
            "scenarios": scenarios}


def ex(v):
    return {"class": "exact", "value": v}


def tm(v):
    return {"class": "timing", "value": v}


def band(lo, hi):
    return {"class": "band", "min": lo, "max": hi}


def bv(v):
    return {"class": "band", "value": v}


def kinds(c):
    return {(f.scenario, f.metric): f.kind for f in c.findings}


def test_exact_increase_is_candidate_and_baseline_kept():
    c = compare(doc({"s": {"statements": ex(4)}}), doc({"s": {"statements": ex(5)}}))
    assert kinds(c) == {("s", "statements"): "candidate"}
    assert c.new_baseline["scenarios"]["s"]["statements"] == ex(4)


def test_exact_decrease_ratchets():
    c = compare(doc({"s": {"statements": ex(4)}}), doc({"s": {"statements": ex(3)}}, commit="c2"))
    assert kinds(c) == {("s", "statements"): "improvement"}
    assert c.new_baseline["scenarios"]["s"]["statements"] == ex(3)
    assert c.new_baseline["commit"] == "c2"


def test_exact_equal_passes_silently():
    c = compare(doc({"s": {"statements": ex(4)}}), doc({"s": {"statements": ex(4)}}))
    assert c.findings == ()


def test_band_inside_passes_above_is_candidate_below_shifts_down():
    base = doc({"s": {"long_tasks": band(1, 3)}})
    assert compare(base, doc({"s": {"long_tasks": bv(3)}})).findings == ()
    assert kinds(compare(base, doc({"s": {"long_tasks": bv(4)}}))) == {("s", "long_tasks"): "candidate"}
    c = compare(base, doc({"s": {"long_tasks": bv(0)}}))
    assert kinds(c) == {("s", "long_tasks"): "improvement"}
    assert c.new_baseline["scenarios"]["s"]["long_tasks"] == band(0, 2)


def test_timing_only_flags_past_factor_and_only_ratchets_past_factor():
    base = doc({"s": {"median_ms": tm(10.0)}})
    assert compare(base, doc({"s": {"median_ms": tm(19.9)}})).findings == ()
    assert kinds(compare(base, doc({"s": {"median_ms": tm(20.1)}}))) == {("s", "median_ms"): "candidate"}
    assert compare(base, doc({"s": {"median_ms": tm(6.0)}})).findings == ()
    c = compare(base, doc({"s": {"median_ms": tm(4.9)}}))
    assert kinds(c) == {("s", "median_ms"): "improvement"}
    assert c.new_baseline["scenarios"]["s"]["median_ms"] == tm(4.9)


def test_new_scenario_and_metric_recorded():
    base = doc({"s": {"statements": ex(4)}})
    c = compare(base, doc({"s": {"statements": ex(4), "bytes": ex(10)},
                           "t": {"long_tasks": bv(2)}}))
    assert kinds(c) == {("s", "bytes"): "new", ("t", "long_tasks"): "new"}
    assert c.new_baseline["scenarios"]["s"]["bytes"] == ex(10)
    assert c.new_baseline["scenarios"]["t"]["long_tasks"] == band(2, 2)


def test_lost_scenario_and_metric_block():
    base = doc({"s": {"statements": ex(4), "bytes": ex(1)}, "t": {"statements": ex(1)}})
    c = compare(base, doc({"s": {"statements": ex(4)}}))
    assert kinds(c) == {("s", "bytes"): "lost", ("t", "*"): "lost"}
    assert {(f.scenario, f.metric) for f in c.blocking} == {("s", "bytes"), ("t", "*")}


def test_class_change_is_reclassified_and_blocks():
    c = compare(doc({"s": {"x": ex(4)}}), doc({"s": {"x": bv(4)}}))
    assert kinds(c) == {("s", "x"): "reclassified"}
    assert len(c.blocking) == 1


def test_incomparable_on_fixture_or_env_change():
    base = doc({})
    assert incomparable_reason(base, doc({})) is None
    assert "fixture_hash" in incomparable_reason(base, doc({}, fixture_hash="fx2"))
    assert "sqlite" in incomparable_reason(base, doc({}, env={"python": "3.12.10", "sqlite": "3.48.0"}))


def test_confirm_outcomes():
    base = doc({"a": {"n": ex(1)}, "b": {"n": ex(1)}, "c": {"n": ex(1)}})
    cands = [Finding("a", "n", "candidate", "1", "2"),
             Finding("b", "n", "candidate", "1", "2"),
             Finding("c", "n", "candidate", "1", "2")]
    rerun = doc({"a": {"n": ex(1)}, "b": {"n": ex(2)}, "c": {"n": ex(2)}})
    mb = doc({"b": {"n": ex(2)}, "c": {"n": ex(1)}})
    assert confirm(base, cands, rerun, mb) == {
        ("a", "n"): "unstable", ("b", "n"): "stale-baseline", ("c", "n"): "regression"}


def test_confirm_without_merge_base_means_regression():
    base = doc({"a": {"n": ex(1)}})
    assert confirm(base, [Finding("a", "n", "candidate", "1", "2")],
                   doc({"a": {"n": ex(2)}}), None) == {("a", "n"): "regression"}


def test_bootstrap_builds_bands_and_timing_median():
    runs = [doc({"s": {"n": ex(4), "lt": bv(v), "ms": tm(t)}})
            for v, t in [(1, 10.0), (3, 30.0), (2, 20.0)]]
    base, unstable = bootstrap(runs)
    assert unstable == ()
    assert base["scenarios"]["s"] == {"n": ex(4), "lt": band(1, 3), "ms": tm(20.0)}


def test_bootstrap_flags_unequal_exact():
    runs = [doc({"s": {"n": ex(4)}}), doc({"s": {"n": ex(5)}})]
    base, unstable = bootstrap(runs)
    assert base is None
    assert [(u.scenario, u.metric, u.values) for u in unstable] == [("s", "n", (4, 5))]


def test_render_table_names_outcome():
    out = render_table([Finding("backlinks/hub", "statements", "candidate", "4", "204")],
                       {("backlinks/hub", "statements"): "regression"})
    assert "| backlinks/hub | statements | 4 | 204 | regression |" in out
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && uv run pytest tests/test_perfcheck_compare.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'perfcheck.compare'`.

- [ ] **Step 3: Implement**

```python
# server/tooling/perfcheck/compare.py
# pattern: Functional Core
"""Judge one perf result against its committed baseline.

Every metric carries a class declared by the check that produced it:
`exact` counts must not rise, `band` counts must stay under the max seen at
bootstrap, `timing` values must not clearly worsen. Improvements are folded
into `Comparison.new_baseline` so they cannot silently erode later; a
worsened value is only a *candidate* until `confirm` has seen a re-run and a
merge-base run."""
from __future__ import annotations

import copy
import statistics
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

TIMING_FACTOR = 2.0

Kind = Literal["candidate", "improvement", "new", "lost", "reclassified"]
Outcome = Literal["regression", "unstable", "stale-baseline"]
Judgement = Literal["pass", "candidate", "improvement"]


@dataclass(frozen=True)
class Finding:
    scenario: str
    metric: str
    kind: Kind
    baseline: str
    now: str


@dataclass(frozen=True)
class Comparison:
    findings: tuple[Finding, ...]
    new_baseline: dict

    @property
    def candidates(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.kind == "candidate")

    @property
    def blocking(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.kind in ("lost", "reclassified"))


@dataclass(frozen=True)
class Unstable:
    scenario: str
    metric: str
    values: tuple[float, ...]


def _show(m: dict) -> str:
    if m["class"] == "band" and "min" in m:
        return f"{m['min']}..{m['max']}"
    return str(m["value"])


def _as_baseline(m: dict) -> dict:
    """A result metric recorded fresh into a baseline."""
    if m["class"] == "band":
        return {"class": "band", "min": m["value"], "max": m["value"]}
    return {"class": m["class"], "value": m["value"]}


def judge(base: dict, now: dict) -> tuple[Judgement, dict]:
    """Verdict for one metric plus the baseline metric to keep."""
    v = now["value"]
    if base["class"] == "exact":
        if v > base["value"]:
            return "candidate", base
        if v < base["value"]:
            return "improvement", {"class": "exact", "value": v}
        return "pass", base
    if base["class"] == "band":
        if v > base["max"]:
            return "candidate", base
        if v < base["min"]:
            shift = base["min"] - v
            return "improvement", {"class": "band", "min": v, "max": base["max"] - shift}
        return "pass", base
    if v > base["value"] * TIMING_FACTOR:
        return "candidate", base
    if v * TIMING_FACTOR < base["value"]:
        return "improvement", {"class": "timing", "value": v}
    return "pass", base


def incomparable_reason(baseline: dict, result: dict) -> str | None:
    if baseline["fixture_hash"] != result["fixture_hash"]:
        return (f"fixture_hash differs (baseline {baseline['fixture_hash']}, "
                f"now {result['fixture_hash']})")
    diffs = [f"{k}: {baseline['env'].get(k)} -> {result['env'].get(k)}"
             for k in sorted(set(baseline["env"]) | set(result["env"]))
             if baseline["env"].get(k) != result["env"].get(k)]
    return "env differs (" + "; ".join(diffs) + ")" if diffs else None


def compare(baseline: dict, result: dict) -> Comparison:
    new = copy.deepcopy(baseline)
    findings: list[Finding] = []
    changed = False
    base_sc, now_sc = baseline["scenarios"], result["scenarios"]
    for name in sorted(base_sc):
        if name not in now_sc:
            findings.append(Finding(name, "*", "lost", "present", "missing"))
    for name in sorted(now_sc):
        metrics = now_sc[name]
        if name not in base_sc:
            new["scenarios"][name] = {k: _as_baseline(m) for k, m in metrics.items()}
            findings.extend(Finding(name, k, "new", "-", _show(m)) for k, m in sorted(metrics.items()))
            changed = True
            continue
        for key in sorted(base_sc[name]):
            if key not in metrics:
                findings.append(Finding(name, key, "lost", _show(base_sc[name][key]), "missing"))
        for key, m in sorted(metrics.items()):
            base_m = base_sc[name].get(key)
            if base_m is None:
                new["scenarios"][name][key] = _as_baseline(m)
                findings.append(Finding(name, key, "new", "-", _show(m)))
                changed = True
                continue
            if base_m["class"] != m["class"]:
                findings.append(Finding(name, key, "reclassified", base_m["class"], m["class"]))
                continue
            verdict, keep = judge(base_m, m)
            if verdict == "pass":
                continue
            findings.append(Finding(name, key, verdict, _show(base_m), _show(m)))
            if verdict == "improvement":
                new["scenarios"][name][key] = keep
                changed = True
    if changed:
        new["commit"] = result["commit"]
    return Comparison(tuple(findings), new)


def _still_worse(baseline: dict, f: Finding, run: dict | None) -> bool | None:
    """None when the run lacks the metric (treated as not reproduced)."""
    if run is None:
        return None
    m = run["scenarios"].get(f.scenario, {}).get(f.metric)
    if m is None:
        return None
    return judge(baseline["scenarios"][f.scenario][f.metric], m)[0] == "candidate"


def confirm(baseline: dict, candidates: Iterable[Finding], rerun: dict,
            merge_base: dict | None) -> dict[tuple[str, str], Outcome]:
    out: dict[tuple[str, str], Outcome] = {}
    for f in candidates:
        key = (f.scenario, f.metric)
        if not _still_worse(baseline, f, rerun):
            out[key] = "unstable"
        elif _still_worse(baseline, f, merge_base):
            out[key] = "stale-baseline"
        else:
            out[key] = "regression"
    return out


def bootstrap(runs: Sequence[dict]) -> tuple[dict | None, tuple[Unstable, ...]]:
    first = runs[0]
    unstable: list[Unstable] = []
    scenarios: dict[str, dict] = {}
    for name, metrics in sorted(first["scenarios"].items()):
        scenarios[name] = {}
        for key, m in sorted(metrics.items()):
            values = tuple(r["scenarios"].get(name, {}).get(key, {}).get("value") for r in runs)
            if any(v is None for v in values):
                unstable.append(Unstable(name, key, values))
                continue
            if m["class"] == "exact":
                if len(set(values)) != 1:
                    unstable.append(Unstable(name, key, values))
                    continue
                scenarios[name][key] = {"class": "exact", "value": values[0]}
            elif m["class"] == "band":
                scenarios[name][key] = {"class": "band", "min": min(values), "max": max(values)}
            else:
                scenarios[name][key] = {"class": "timing", "value": statistics.median(values)}
    if unstable:
        return None, tuple(unstable)
    return ({"commit": first["commit"], "fixture_hash": first["fixture_hash"],
             "env": dict(first["env"]), "scenarios": scenarios}, ())


def render_table(findings: Iterable[Finding],
                 outcomes: Mapping[tuple[str, str], Outcome]) -> str:
    rows = ["| scenario | metric | baseline | now | verdict |",
            "|---|---|---|---|---|"]
    for f in findings:
        verdict = outcomes.get((f.scenario, f.metric), f.kind)
        rows.append(f"| {f.scenario} | {f.metric} | {f.baseline} | {f.now} | {verdict} |")
    return "\n".join(rows)
```

- [ ] **Step 4: Run tests**

Run: `cd server && uv run pytest tests/test_perfcheck_compare.py -q && uv run pyrefly check && uv run ruff check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/tooling/perfcheck/compare.py server/tests/test_perfcheck_compare.py
git commit -m "perf(<id>): compare/confirm/bootstrap core for perf baselines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Deterministic fixture generator

**Files:**
- Create: `server/tooling/perfcheck/fixture.py`
- Test: `server/tests/test_perfcheck_fixture.py`

**Interfaces:**
- Consumes: `pkm.contracts.daily.title_for_date`
- Produces (used by Tasks 3, 4, 6):
  - `FROZEN_NOW: datetime` = `datetime(2026, 6, 15, 12, 0, tzinfo=ZoneInfo("Europe/London"))`; `FROZEN_NOW_MS: int`; `FROZEN_TODAY: date`
  - `BIG_PAGE = "Perf Big Page"`, `HUBS: tuple[str, ...]` (5 titles, `HUBS[0] == "Hub Alpha"`), `COMMON_TERM = "project"`, `RARE_TERM = "zyxquark"`, `PREFIX_TERM = "synchro"`, `PHRASE = "quantum lattice"`
  - `Batch(now_ms: int, ops: tuple[dict, ...])`
  - `AssetRow(sha256: str, filename: str, mime: str, size: int, created_at: int, description: str | None)`
  - `Landmarks(big_page: str, hub: str, journal_day: str, popular_uid: str, ref_uids: tuple[str, ...], move_uid: str, edit_uid: str)`
  - `Fixture(batches: tuple[Batch, ...], assets: tuple[AssetRow, ...], sidebar: tuple[str, ...], landmarks: Landmarks)`
  - `generate(seed: int = 1, scale: float = 1.0) -> Fixture`

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_perfcheck_fixture.py
from collections import Counter

from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import OpBatch
from perfcheck.fixture import (BIG_PAGE, FROZEN_TODAY, HUBS, PHRASE, RARE_TERM,
                               generate)


def creates(fx):
    return [op for b in fx.batches for op in b.ops if op["op"] == "create"]


def test_same_seed_same_fixture():
    assert generate(1, 0.02) == generate(1, 0.02)
    assert generate(1, 0.02) != generate(2, 0.02)


def test_full_scale_shape():
    fx = generate(1, 1.0)
    cs = creates(fx)
    assert 45_000 <= len(cs) <= 55_000
    per_page = Counter(op["page_title"] for op in cs)
    assert 3_500 <= len(per_page) <= 4_600
    assert per_page[BIG_PAGE] == 1_200
    journal = [t for t in per_page if t.endswith(", 2026") or t.endswith(", 2025")]
    assert len(journal) >= 365
    assert title_for_date(FROZEN_TODAY) in per_page  # GET /api/journal must never create a page
    for hub in HUBS:
        backlinks = sum(1 for op in cs if f"[[{hub}]]" in op["text"])
        assert 150 <= backlinks <= 450, hub
    assert sum(1 for op in cs if RARE_TERM in op["text"]) == 3
    assert sum(1 for op in cs if PHRASE in op["text"]) == 12
    assert sum(1 for op in cs if op["text"].startswith("{{[[TODO]]}}")) > 500
    ref_counts = Counter(u for op in cs for u in _refs(op["text"]))
    assert ref_counts[fx.landmarks.popular_uid] >= 50


def _refs(text):
    import re
    return re.findall(r"\(\(([a-zA-Z0-9_-]{6,})\)\)", text)


def test_every_batch_validates_and_parents_precede_children():
    fx = generate(1, 0.02)
    seen: set[str] = set()
    for i, b in enumerate(fx.batches):
        assert len(b.ops) <= 400
        OpBatch.model_validate({"client_id": "perf-fixture",
                                "batch_id": f"fixture-{i:06d}", "ops": list(b.ops)})
        for op in b.ops:
            if op["op"] == "create":
                assert op["parent_uid"] is None or op["parent_uid"] in seen
                seen.add(op["uid"])


def test_batches_are_time_ordered_and_not_after_frozen_now():
    from perfcheck.fixture import FROZEN_NOW_MS
    fx = generate(1, 0.02)
    times = [b.now_ms for b in fx.batches]
    assert times == sorted(times)
    assert times[-1] <= FROZEN_NOW_MS


def test_landmarks_exist():
    fx = generate(1, 0.02)
    uids = {op["uid"] for op in creates(fx)}
    lm = fx.landmarks
    assert {lm.popular_uid, lm.move_uid, lm.edit_uid} <= uids
    assert set(lm.ref_uids) <= uids and len(lm.ref_uids) == 30
    kids = [op for op in creates(fx) if op["parent_uid"] == lm.move_uid]
    assert kids, "move_uid must have children so the move is a subtree move"
    assert fx.assets and fx.sidebar
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && uv run pytest tests/test_perfcheck_fixture.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'perfcheck.fixture'`.

- [ ] **Step 3: Implement**

```python
# server/tooling/perfcheck/fixture.py
# pattern: Functional Core
"""A deterministic, prod-shaped graph for the perf checks, as op batches.

Shaped after prod on 2026-09-26 (~56k blocks, 4.4k pages, largest page
1,222 blocks). Pure: same (seed, scale) gives an identical Fixture, so the
counts measured against it are comparable across commits. The hash of this
file's source is the baseline's `fixture_hash` -- editing it invalidates
every baseline, so change it deliberately and rebaseline."""
from __future__ import annotations

import hashlib
import random
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from pkm.contracts.daily import title_for_date

FROZEN_NOW = datetime(2026, 6, 15, 12, 0, tzinfo=ZoneInfo("Europe/London"))
FROZEN_NOW_MS = int(FROZEN_NOW.timestamp() * 1000)
FROZEN_TODAY = FROZEN_NOW.date()

BIG_PAGE = "Perf Big Page"
HUBS = ("Hub Alpha", "Hub Beta", "Hub Gamma", "Hub Delta", "Hub Epsilon")
COMMON_TERM = "project"
RARE_TERM = "zyxquark"
PREFIX_TERM = "synchro"
PHRASE = "quantum lattice"

BATCH_OPS = 400
DAY_MS = 86_400_000

_SYLLABLES = ("ka", "lo", "mi", "ren", "sa", "tor", "vel", "qui", "dan", "ber",
              "nel", "pho", "stra", "gen", "ul", "ix", "mor", "tal", "shi", "e")
# Head of the Zipf distribution: real words so search has meaningful common
# hits; the synchro* family exists for the prefix scenario.
_HEAD = (COMMON_TERM, "meeting", "notes", "idea", "review", "draft", "reading",
         "question", "follow", "design", "synchronise", "synchrony", "synchrotron")


@dataclass(frozen=True)
class Batch:
    now_ms: int
    ops: tuple[dict, ...]


@dataclass(frozen=True)
class AssetRow:
    sha256: str
    filename: str
    mime: str
    size: int
    created_at: int
    description: str | None


@dataclass(frozen=True)
class Landmarks:
    big_page: str
    hub: str
    journal_day: str
    popular_uid: str
    ref_uids: tuple[str, ...]
    move_uid: str
    edit_uid: str


@dataclass(frozen=True)
class Fixture:
    batches: tuple[Batch, ...]
    assets: tuple[AssetRow, ...]
    sidebar: tuple[str, ...]
    landmarks: Landmarks


class _Gen:
    def __init__(self, seed: int, scale: float) -> None:
        self.rng = random.Random(seed)
        self.scale = scale
        self.n = 0
        rng = random.Random(seed + 7919)
        tail = sorted({"".join(rng.choice(_SYLLABLES) for _ in range(rng.randint(2, 3)))
                       for _ in range(600)})
        self.vocab = list(_HEAD) + tail
        self.weights = [1.0 / (i + 1) ** 1.1 for i in range(len(self.vocab))]
        self.topics = [f"Topic {i:04d}" for i in range(max(20, round(4000 * scale)))]
        self.all_uids: list[str] = []
        self.popular: list[str] = []
        self.creates: list[tuple[int, dict]] = []  # (now_ms, op)
        self.edits: list[tuple[int, dict]] = []

    def uid(self) -> str:
        self.n += 1
        return f"f{self.n:011d}"

    def words(self, k: int) -> str:
        return " ".join(self.rng.choices(self.vocab, self.weights, k=k))

    def text(self) -> str:
        r = self.rng.random
        parts = [self.words(self.rng.randint(4, 18))]
        if r() < 0.08:
            parts.append(f"[[{self.rng.choice(self.topics)}]]")
        if r() < 0.032:
            parts.append(f"[[{self.rng.choice(HUBS)}]]")
        if r() < 0.01:
            parts.append(f"see {self.rng.choice(HUBS)} for context")  # unlinked mention
        if r() < 0.04:
            parts.append(f"#tag{self.rng.randint(0, 19)}")
        if r() < 0.02 and self.popular:
            parts.append(f"(({self.rng.choice(self.popular)}))")
        body = " ".join(parts)
        roll = r()
        if roll < 0.03:
            return "{{[[TODO]]}} " + body
        if roll < 0.05:
            return "{{[[DONE]]}} " + body
        return body

    def page(self, title: str, count: int, now_ms: int, special: list[str] | None = None) -> list[str]:
        """Create `count` blocks on `title`, nesting some under the previous
        block (depth <= 4). Returns the uids in creation order."""
        stack: list[tuple[str, int]] = []   # (uid, depth) path to the last block
        next_idx: dict[str | None, int] = {}
        uids: list[str] = []
        texts = list(special or [])
        for i in range(count):
            if stack and self.rng.random() < 0.35 and stack[-1][1] < 4:
                parent, depth = stack[-1][0], stack[-1][1] + 1
            else:
                while stack and self.rng.random() < 0.5:
                    stack.pop()
                parent = stack[-1][0] if stack else None
                depth = stack[-1][1] + 1 if stack else 0
            idx = next_idx.get(parent, 0)
            next_idx[parent] = idx + 1
            uid = self.uid()
            text = texts[i] if i < len(texts) else self.text()
            self.creates.append((now_ms, {"op": "create", "uid": uid, "page_title": title,
                                          "parent_uid": parent, "order_idx": idx, "text": text}))
            while stack and stack[-1][1] >= depth:
                stack.pop()
            stack.append((uid, depth))
            uids.append(uid)
            self.all_uids.append(uid)
        return uids


def generate(seed: int = 1, scale: float = 1.0) -> Fixture:
    g = _Gen(seed, scale)
    year_start = FROZEN_NOW_MS - 365 * DAY_MS

    # Blocks that attract ((refs)): created first so later text can cite them.
    seed_uids = g.page("Reference Library", max(10, round(50 * scale)), year_start)
    g.popular = seed_uids
    popular_uid = seed_uids[0]
    # Weight the first seed block heavily so one block has many backlinks.
    g.popular = [popular_uid] * len(seed_uids) + seed_uids

    for hub in HUBS:
        g.page(hub, max(5, round(40 * scale)), year_start)

    big_special = [
        "```mermaid\ngraph TD\n  A-->B\n  B-->C\n```",
        "$$\\int_0^1 x^2\\,dx = \\tfrac13$$",
        "```python\nprint('perf')\n```",
        "```js\nconsole.log('perf')\n```",
    ]
    big_count = 1200 if scale >= 1.0 else max(50, round(1200 * scale))
    big_uids = g.page(BIG_PAGE, big_count, year_start + DAY_MS, big_special)

    n_days = max(8, round(365 * scale))
    journal_titles = []
    for d in range(n_days):
        day = FROZEN_TODAY - timedelta(days=n_days - 1 - d)
        noon = FROZEN_NOW_MS - (n_days - 1 - d) * DAY_MS
        title = title_for_date(day)
        journal_titles.append(title)
        g.page(title, g.rng.randint(4, 16), noon)

    target = round(50_000 * scale)
    remaining = max(0, target - len(g.all_uids))
    sizes = [min(400, max(1, int(g.rng.paretovariate(1.6) * 4))) for _ in g.topics]
    total = sum(sizes)
    sizes = [max(1, round(s * remaining / total)) for s in sizes]
    for i, (topic, size) in enumerate(zip(g.topics, sizes)):
        when = year_start + (i * 365 * DAY_MS) // len(g.topics)
        g.page(topic, size, when)

    # Plant exact-count search terms into existing creates (deterministic spots).
    rare_spots = g.rng.sample(range(len(g.creates)), 3)
    phrase_spots = g.rng.sample([i for i in range(len(g.creates)) if i not in rare_spots], 12)
    for i in rare_spots:
        g.creates[i][1]["text"] += f" {RARE_TERM}"
    for i in phrase_spots:
        g.creates[i][1]["text"] += f" {PHRASE}"

    # Later edits so /api/changed sees "edited" as well as "new" blocks.
    # An edit must land strictly after its block's create batch.
    created_at = {op["uid"]: when for when, op in g.creates}
    for uid in g.rng.sample(g.all_uids, max(5, len(g.all_uids) // 20)):
        when = FROZEN_NOW_MS - g.rng.randint(1, 30) * DAY_MS
        if when <= created_at[uid]:
            lo, hi = created_at[uid] + DAY_MS, FROZEN_NOW_MS - DAY_MS
            if lo > hi:
                continue
            when = g.rng.randint(lo, hi)
        g.edits.append((when, {"op": "update_text", "uid": uid, "text": g.text() + " (edited)"}))

    timed = sorted(g.creates + g.edits, key=lambda t: t[0])  # stable: page order kept
    batches: list[Batch] = []
    current: list[dict] = []
    current_ms = timed[0][0]
    for when, op in timed:
        if current and (when != current_ms or len(current) == BATCH_OPS):
            batches.append(Batch(current_ms, tuple(current)))
            current = []
        current_ms = when
        current.append(op)
    batches.append(Batch(current_ms, tuple(current)))

    assets = tuple(
        AssetRow(sha256=hashlib.sha256(f"perf-asset-{i}".encode()).hexdigest(),
                 filename=f"{'diagram' if i % 3 == 0 else 'scan'}-{i:03d}.{'png' if i % 2 else 'pdf'}",
                 mime="image/png" if i % 2 else "application/pdf",
                 size=10_000 + i * 97,
                 created_at=year_start + i * DAY_MS,
                 description=f"a diagram of {g.words(5)}" if i % 4 else None)
        for i in range(max(10, round(200 * scale))))

    move_uid = next(op["parent_uid"] for _, op in g.creates
                    if op["page_title"] == BIG_PAGE and op["parent_uid"] is not None)
    landmarks = Landmarks(
        big_page=BIG_PAGE, hub=HUBS[0], journal_day=journal_titles[-4],
        popular_uid=popular_uid, ref_uids=tuple(g.rng.sample(g.all_uids, 30)),
        move_uid=move_uid, edit_uid=big_uids[10])
    sidebar = (BIG_PAGE, *HUBS, *g.topics[:4])
    return Fixture(tuple(batches), assets, sidebar, landmarks)
```

Add to the test file (edits must follow their creates — `timed` is sorted by time, so an edit drawn before its block's create would reference a missing uid):

```python
def test_edits_follow_their_creates():
    fx = generate(1, 0.02)
    created: dict[str, int] = {}
    for b in fx.batches:
        for op in b.ops:
            if op["op"] == "create":
                created[op["uid"]] = b.now_ms
            else:
                assert op["uid"] in created and created[op["uid"]] < b.now_ms
```

- [ ] **Step 4: Run tests; tune constants until shape tests pass**

Run: `cd server && uv run pytest tests/test_perfcheck_fixture.py -q`
Expected: PASS. If a shape assertion fails (e.g. hub backlinks out of 150–450, total blocks out of range), adjust the probability or size constants in `fixture.py` — never loosen the test ranges, they encode prod's shape.

- [ ] **Step 5: Lint, types, commit**

```bash
cd server && uv run pyrefly check && uv run ruff check
git add server/tooling/perfcheck/fixture.py server/tests/test_perfcheck_fixture.py
git commit -m "perf(<id>): deterministic prod-shaped fixture generator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Fixture builder with cache

**Files:**
- Create: `server/tooling/perfcheck/build.py`
- Test: `server/tests/test_perfcheck_build.py`

**Interfaces:**
- Consumes: `generate`, `Fixture`, `AssetRow` (Task 2); `pkm.server.db.init_db`, `open_db`; `pkm.server.ops_apply.apply_batch`; `pkm.contracts.ops.OpBatch`; `pkm.schema.DDL`
- Produces (Tasks 4, 7):
  - `fixture_hash() -> str` — sha256 hex (first 16 chars) of `fixture.py` source only
  - `cache_key(seed: int, scale: float) -> str` — hash of `fixture.py` source + `pkm.schema.DDL` + seed + scale
  - `cache_dir() -> Path` — `$PKM_PERF_CACHE` or `~/.cache/pkm-perf`, created if missing
  - `build(dest: Path, seed: int = 1, scale: float = 1.0) -> None`
  - `cached_fixture(seed: int = 1, scale: float = 1.0) -> Path`

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_perfcheck_build.py
import sqlite3

import pytest

from perfcheck import build as b
from perfcheck.fixture import generate


@pytest.fixture()
def cache(tmp_path, monkeypatch):
    monkeypatch.setenv("PKM_PERF_CACHE", str(tmp_path / "cache"))
    return tmp_path / "cache"


def test_build_applies_every_create(tmp_path):
    dest = tmp_path / "fx.sqlite3"
    b.build(dest, seed=1, scale=0.02)
    fx = generate(1, 0.02)
    n_creates = sum(1 for bt in fx.batches for op in bt.ops if op["op"] == "create")
    con = sqlite3.connect(dest)
    assert con.execute("SELECT COUNT(*) FROM blocks").fetchone()[0] == n_creates
    assert con.execute("SELECT COUNT(*) FROM assets").fetchone()[0] == len(fx.assets)
    assert con.execute("SELECT COUNT(*) FROM sidebar_entries").fetchone()[0] == len(fx.sidebar)
    # triggers ran: FTS and the change journal are populated
    assert con.execute("SELECT COUNT(*) FROM blocks_fts").fetchone()[0] == n_creates
    assert con.execute("SELECT COUNT(*) FROM changes").fetchone()[0] > 0
    assert con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_cached_fixture_reuses_file(cache):
    p1 = b.cached_fixture(1, 0.02)
    mtime = p1.stat().st_mtime_ns
    p2 = b.cached_fixture(1, 0.02)
    assert p1 == p2 and p2.stat().st_mtime_ns == mtime
    assert p1.parent == cache


def test_cache_key_tracks_ddl_but_fixture_hash_does_not(monkeypatch):
    k1, h1 = b.cache_key(1, 1.0), b.fixture_hash()
    monkeypatch.setattr(b, "DDL", b.DDL + "\n-- changed")
    assert b.cache_key(1, 1.0) != k1
    assert b.fixture_hash() == h1


def test_failed_build_leaves_no_cache_file(cache, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("boom")
    monkeypatch.setattr(b, "apply_batch", boom)
    with pytest.raises(RuntimeError):
        b.cached_fixture(1, 0.02)
    assert not list(cache.glob("*.sqlite3"))
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && uv run pytest tests/test_perfcheck_build.py -q`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```python
# server/tooling/perfcheck/build.py
# pattern: Imperative Shell
"""Materialise the perf fixture into a SQLite DB through the real write path.

Ops go through ops_apply.apply_batch -- the same function POST /api/ops
uses -- so triggers fill blocks_fts, refs, block_refs and changes exactly as
in prod. Two keys, on purpose: `cache_key` (generator + DDL) decides when the
cached DB is rebuilt; `fixture_hash` (generator only) decides whether two
runs are comparable, so a schema change is measured against the baseline
rather than excused from it."""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

from pkm.contracts.ops import OpBatch
from pkm.schema import DDL
from pkm.server.db import init_db, open_db
from pkm.server.ops_apply import apply_batch

from perfcheck import fixture as _fixture_mod
from perfcheck.fixture import generate

_FIXTURE_SRC = Path(_fixture_mod.__file__).read_bytes()


def fixture_hash() -> str:
    return hashlib.sha256(_FIXTURE_SRC).hexdigest()[:16]


def cache_key(seed: int, scale: float) -> str:
    h = hashlib.sha256()
    for part in (_FIXTURE_SRC, DDL.encode(), f"{seed}:{scale}".encode()):
        h.update(part)
    return h.hexdigest()[:16]


def cache_dir() -> Path:
    d = Path(os.environ.get("PKM_PERF_CACHE", Path.home() / ".cache" / "pkm-perf"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def build(dest: Path, seed: int = 1, scale: float = 1.0) -> None:
    fx = generate(seed, scale)
    init_db(dest)
    con = open_db(dest)
    try:
        for i, batch in enumerate(fx.batches):
            ob = OpBatch.model_validate({"client_id": "perf-fixture",
                                         "batch_id": f"fixture-{i:06d}",
                                         "ops": list(batch.ops)})
            apply_batch(con, ob, batch.now_ms)
            con.commit()
        con.executemany(
            "INSERT INTO assets(sha256, filename, mime, size, created_at, description)"
            " VALUES (?,?,?,?,?,?)",
            [(a.sha256, a.filename, a.mime, a.size, a.created_at, a.description) for a in fx.assets])
        con.executemany("INSERT INTO sidebar_entries(title, order_idx) VALUES (?,?)",
                        [(t, i) for i, t in enumerate(fx.sidebar)])
        con.commit()
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        con.close()


def cached_fixture(seed: int = 1, scale: float = 1.0) -> Path:
    target = cache_dir() / f"fixture-{cache_key(seed, scale)}.sqlite3"
    if target.exists():
        return target
    fd, tmp_name = tempfile.mkstemp(suffix=".sqlite3", dir=target.parent)
    os.close(fd)
    tmp = Path(tmp_name)
    tmp.unlink()  # init_db wants to create it
    try:
        build(tmp, seed, scale)
        tmp.replace(target)
    finally:
        for p in (tmp, Path(f"{tmp}-wal"), Path(f"{tmp}-shm")):
            p.unlink(missing_ok=True)
    return target
```

- [ ] **Step 4: Run tests; time a full build once**

Run: `cd server && uv run pytest tests/test_perfcheck_build.py -q`
Expected: PASS.

Then: `cd server && time PYTHONPATH=tooling uv run python -c "from perfcheck.build import cached_fixture; print(cached_fixture())"`
Expected: a path under `~/.cache/pkm-perf/`; note the wall time in the commit message. If it exceeds a few minutes, profile before moving on (the ops path is O(ops); something quadratic is a real finding worth a bean).

- [ ] **Step 5: Lint, types, commit**

```bash
cd server && uv run pyrefly check && uv run ruff check
git add server/tooling/perfcheck/build.py server/tests/test_perfcheck_build.py
git commit -m "perf(<id>): build and cache the fixture DB through apply_batch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: SQL tracer and backend check

**Files:**
- Create: `server/tooling/perfcheck/sqlplan.py` (Functional Core)
- Create: `server/tooling/perfcheck/trace.py` (Imperative Shell)
- Create: `server/tooling/perfcheck/backend.py` (Imperative Shell; also `python -m perfcheck.backend`)
- Test: `server/tests/test_perfcheck_sqlplan.py`, `server/tests/test_perfcheck_backend.py`

**Interfaces:**
- Consumes: `cached_fixture`, `fixture_hash` (Task 3); `generate`, `Landmarks`, `FROZEN_NOW` (Task 2); `pkm.server.app.create_app`, `pkm.server.db.get_db`, `open_db`; `pkm.server.config.Config`; `pkm.server.auth_core.hash_password`; `pkm.describe.service.DescribeService`
- Produces (Task 7):
  - `sqlplan.plannable(sql: str) -> bool`; `sqlplan.full_scans(details: Iterable[str], tables: set[str]) -> list[str]`
  - `trace.Tracer` with `.get_db(request)` (FastAPI dependency), `.start()`, `.stop() -> Tally`; `Tally(statements: list[str], trigger_statements: int, ticks: int)`; `PROGRESS_N = 1000`
  - `backend.Scenario(name, method, path, params=None, body=None, writes=False)`; `backend.scenarios(lm: Landmarks, max_seq: int) -> list[Scenario]`
  - `backend.run(fixture_db: Path, *, only: set[str] | None = None, repeats: int = 5, scale: float = 1.0) -> dict` — a result document (Task 1 shape)
  - CLI: `python -m perfcheck.backend --out PATH [--only a,b] [--scale 1.0] [--commit SHA]`

- [ ] **Step 1: Failing tests for the pure plan helpers**

```python
# server/tests/test_perfcheck_sqlplan.py
from perfcheck.sqlplan import full_scans, plannable

TABLES = {"blocks", "pages", "refs"}


def test_plannable_only_dml_and_select():
    assert plannable("SELECT 1")
    assert plannable("  with x as (select 1) select * from x")
    assert plannable("UPDATE blocks SET text='a' WHERE uid='b'")
    assert not plannable("-- TRIGGER blocks_fts_ai")
    assert not plannable("PRAGMA foreign_keys=ON")
    assert not plannable("BEGIN")


def test_full_scans_ignores_indexed_virtual_and_cte():
    details = ["SCAN blocks", "SCAN pages USING INDEX idx_x", "SEARCH refs USING INDEX r (b=?)",
               "SCAN blocks_fts VIRTUAL TABLE INDEX 0:M1", "SCAN chain", "SCAN CONSTANT ROW",
               "SCAN refs USING COVERING INDEX r2"]
    assert full_scans(details, TABLES) == ["SCAN blocks"]
```

- [ ] **Step 2: Run, verify failure, implement `sqlplan.py`**

Run: `cd server && uv run pytest tests/test_perfcheck_sqlplan.py -q` → FAIL (module not found).

```python
# server/tooling/perfcheck/sqlplan.py
# pattern: Functional Core
"""Classify traced SQL and EXPLAIN QUERY PLAN rows for the backend check."""
from __future__ import annotations

from collections.abc import Iterable

_PLANNABLE = ("SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "REPLACE")


def plannable(sql: str) -> bool:
    return sql.lstrip().upper().startswith(_PLANNABLE)


def full_scans(details: Iterable[str], tables: set[str]) -> list[str]:
    """Plan rows that read a real table with no index. CTEs, constant rows
    and FTS virtual tables are not table scans in the sense that matters."""
    out = []
    for d in details:
        if not d.startswith("SCAN ") or " USING " in d or "VIRTUAL TABLE" in d:
            continue
        name = d.split()[1]
        if name in tables:
            out.append(d)
    return out
```

Run again → PASS.

- [ ] **Step 3: Failing tests for the tracer and backend check**

```python
# server/tests/test_perfcheck_backend.py
import pytest

from perfcheck import backend
from perfcheck.build import build


@pytest.fixture(scope="module")
def small_fixture(tmp_path_factory):
    dest = tmp_path_factory.mktemp("fx") / "fx.sqlite3"
    build(dest, seed=1, scale=0.02)
    return dest


@pytest.fixture(scope="module")
def result(small_fixture):
    return backend.run(small_fixture, repeats=1, scale=0.02)


def test_every_scenario_measured(result):
    names = set(result["scenarios"])
    assert {"page/big", "page/hub", "journal/head", "search/common", "search/rare",
            "search/prefix", "search/phrase", "search/many-hits", "search/title",
            "assets/search", "sync/snapshot", "ops/edit-1", "ops/paste-50",
            "ops/move-subtree", "rename/hub"} <= names
    for name, m in result["scenarios"].items():
        assert m["statements"]["class"] == "exact", name
        assert m["statements"]["value"] >= 1, name
        assert m["bytes"]["value"] > 0, name
        assert m["median_ms"]["class"] == "timing", name


def test_counts_are_deterministic_across_runs(small_fixture, result):
    again = backend.run(small_fixture, repeats=1, scale=0.02)

    def strip(r):
        return {s: {k: v for k, v in m.items() if v["class"] != "timing"}
                for s, m in r["scenarios"].items()}
    assert strip(again) == strip(result)


def test_writes_hit_a_fresh_copy(small_fixture, result):
    # the paste scenario's statement count would grow run to run if writes
    # accumulated in the cached fixture
    import sqlite3
    con = sqlite3.connect(small_fixture)
    assert con.execute("SELECT COUNT(*) FROM blocks WHERE uid LIKE 'pp%'").fetchone()[0] == 0


def test_trace_sees_expanded_sql(small_fixture):
    from perfcheck.trace import Tracer
    t = Tracer()
    client = backend.make_client(small_fixture, t)
    t.start()
    client.get("/api/search", params={"q": "project"})
    tally = t.stop()
    assert any("'project" in s or '"project' in s for s in tally.statements), tally.statements


def test_result_document_shape(result):
    assert set(result) == {"commit", "fixture_hash", "env", "scenarios"}
    assert set(result["env"]) == {"python", "sqlite"}
```

And add the Review Focus test for counted-run agreement (the check runs every counted scenario twice and raises if the two tallies differ):

```python
def test_counted_runs_agree(monkeypatch, small_fixture):
    calls = {"n": 0}
    real = backend._count_once

    def flaky(*a, **k):
        calls["n"] += 1
        out = real(*a, **k)
        if calls["n"] == 2:
            out = {**out, "statements": out["statements"] + 1}
        return out
    monkeypatch.setattr(backend, "_count_once", flaky)
    with pytest.raises(backend.UnstableCountError, match="page/big"):
        backend.run(small_fixture, only={"page/big"}, repeats=1, scale=0.02)
```

- [ ] **Step 4: Run to verify failure**

Run: `cd server && uv run pytest tests/test_perfcheck_backend.py -q` → FAIL (module not found).

- [ ] **Step 5: Implement `trace.py`**

```python
# server/tooling/perfcheck/trace.py
# pattern: Imperative Shell
"""Per-request SQL accounting via a get_db dependency override.

Every route opens its connection through `pkm.server.db.get_db`, so
overriding that one dependency sees all of a request's SQL. Statements
reported with a leading "--" are trigger bodies (sqlite's trace output);
they are tallied separately because FTS/refs triggers dominate write cost."""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field

import sqlite3
from fastapi import Request

from pkm.server.db import open_db

PROGRESS_N = 1000


@dataclass
class Tally:
    statements: list[str] = field(default_factory=list)
    trigger_statements: int = 0
    ticks: int = 0


class Tracer:
    def __init__(self) -> None:
        self._tally: Tally | None = None

    def start(self) -> None:
        self._tally = Tally()

    def stop(self) -> Tally:
        assert self._tally is not None, "stop() without start()"
        t, self._tally = self._tally, None
        return t

    def _on_sql(self, sql: str) -> None:
        if self._tally is None:
            return
        if sql.lstrip().startswith("--"):
            self._tally.trigger_statements += 1
        else:
            self._tally.statements.append(sql)

    def _on_progress(self) -> int:
        if self._tally is not None:
            self._tally.ticks += 1
        return 0

    def get_db(self, request: Request) -> Iterator[sqlite3.Connection]:
        con = open_db(request.app.state.config.db_path)
        if self._tally is not None:
            con.set_trace_callback(self._on_sql)
            con.set_progress_handler(self._on_progress, PROGRESS_N)
        try:
            yield con
        finally:
            con.close()
```

- [ ] **Step 6: Implement `backend.py`**

Before writing scenario params, read each route's signature to confirm parameter names (already verified while planning: `/api/search` `q, limit (≤100), exact`; `/api/block-refs` `uids` comma-separated; `/api/journal` `before` ISO date, `days`; `/api/assets/search` `q, type ∈ {"",image,pdf,document,other}, from_ms, to_ms, linked`; `/api/changed` `since` 'YYYY-MM-DD'; `/api/sync/changes` `since` seq, `limit`; `/api/unlinked` `title`; rename body `{"new_title": ...}`).

```python
# server/tooling/perfcheck/backend.py
# pattern: Imperative Shell
"""Backend perf check: fixed API scenarios, in-process, against the fixture.

Per scenario: two counted runs (tracer + progress handler on; they must
agree, else the count is not gateable) then one warm-up and `repeats` timed
runs with no instrumentation. Writes run against a fresh copy of the
fixture every time so they never accumulate."""
from __future__ import annotations

import argparse
import json
import platform
import shutil
import sqlite3
import statistics
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import time_machine
from fastapi.testclient import TestClient

from pkm.describe.service import DescribeService
from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import get_db

from perfcheck.build import cached_fixture, fixture_hash
from perfcheck.fixture import FROZEN_NOW, Landmarks, generate
from perfcheck.sqlplan import full_scans, plannable
from perfcheck.trace import Tracer

PASSWORD = "perf-pw"
SALT = bytes.fromhex("22" * 16)


class UnstableCountError(RuntimeError):
    pass


@dataclass(frozen=True)
class Scenario:
    name: str
    method: str
    path: str
    params: dict | None = None
    body: dict | None = None
    writes: bool = False


def scenarios(lm: Landmarks, max_seq: int) -> list[Scenario]:
    def g(name: str, path: str, **params: object) -> Scenario:
        return Scenario(name, "GET", path, params or None)

    paste = [{"op": "create", "uid": "pp00000000", "page_title": lm.big_page,
              "parent_uid": None, "order_idx": 0, "text": "pasted parent"}]
    paste += [{"op": "create", "uid": f"pp{i:08d}", "page_title": lm.big_page,
               "parent_uid": "pp00000000", "order_idx": i - 1, "text": f"pasted line {i} project"}
              for i in range(1, 50)]

    def batch(ops: list[dict]) -> dict:
        return {"client_id": "perf-check", "batch_id": "perfcheck-000001", "ops": ops}

    return [
        g("page/big", f"/api/page/{lm.big_page}"),
        g("page/hub", f"/api/page/{lm.hub}"),
        g("page/hub-deep", f"/api/page/{lm.hub}", bl_offset=200, bl_limit=20),
        g("page/journal-day", f"/api/page/{lm.journal_day}"),
        g("journal/head", "/api/journal"),
        g("journal/before", "/api/journal", before="2026-03-01", days=7),
        g("block/get", f"/api/block/{lm.edit_uid}"),
        g("block/backlinks", f"/api/block/{lm.popular_uid}/backlinks"),
        g("block-refs/30", "/api/block-refs", uids=",".join(lm.ref_uids)),
        g("unlinked/hub", "/api/unlinked", title=lm.hub),
        g("search/common", "/api/search", q="project"),
        g("search/rare", "/api/search", q="zyxquark"),
        g("search/prefix", "/api/search", q="synchro"),
        g("search/phrase", "/api/search", q="quantum lattice", exact="true"),
        g("search/many-hits", "/api/search", q="project", limit=100),
        g("search/title", "/api/search", q="Topic"),
        g("titles/prefix", "/api/titles", q="Top"),
        g("titles/infix", "/api/titles", q="pha"),
        g("assets/search", "/api/assets/search", q="diagram", type="image"),
        g("assets/range", "/api/assets/search",
          from_ms=int(FROZEN_NOW.timestamp() * 1000) - 180 * 86_400_000),
        g("todos/all", "/api/todos"),
        g("changed/week", "/api/changed", since="2026-06-08"),
        g("query/and-not", "/api/query", expr=f"{{and: [[{lm.hub}]] {{not: [[Hub Beta]]}}}}"),
        g("sidebar", "/api/sidebar"),
        g("sync/snapshot", "/api/sync/snapshot"),
        g("sync/changes-mid", "/api/sync/changes", since=max_seq // 2),
        Scenario("ops/edit-1", "POST", "/api/ops", body=batch(
            [{"op": "update_text", "uid": lm.edit_uid, "text": "edited by the perf check"}]), writes=True),
        Scenario("ops/paste-50", "POST", "/api/ops", body=batch(paste), writes=True),
        Scenario("ops/move-subtree", "POST", "/api/ops", body=batch(
            [{"op": "move", "uid": lm.move_uid, "parent_uid": None, "order_idx": 0,
              "page_title": lm.hub}]), writes=True),
        Scenario("rename/hub", "POST", f"/api/page/{lm.hub}/rename",
                 body={"new_title": f"{lm.hub} Renamed"}, writes=True),
    ]


def make_client(db_path: Path, tracer: Tracer) -> TestClient:
    data = db_path.parent
    config = Config(db_path=db_path, assets_dir=data / "assets",
                    password_salt=SALT.hex(), password_hash=hash_password(PASSWORD, SALT),
                    session_secret="ab" * 32, cookie_secure=False,
                    openai_api_key_file=data / "no-openai", zai_api_key_file=data / "no-zai",
                    goodlinks_api_key_file=data / "no-goodlinks")
    describe = DescribeService(config, None, "disabled for perf check")
    app = create_app(config, describe_service=describe)
    app.dependency_overrides[get_db] = tracer.get_db
    client = TestClient(app)  # no `with`: lifespan (background workers) never starts
    r = client.post("/api/login", json={"password": PASSWORD})
    r.raise_for_status()
    return client


def _call(client: TestClient, s: Scenario):
    r = client.request(s.method, s.path, params=s.params, json=s.body)
    if r.status_code != 200:
        raise RuntimeError(f"{s.name}: HTTP {r.status_code} {r.text[:300]}")
    return r


class _Env:
    """A private copy of the fixture per scenario run (fresh for writes)."""

    def __init__(self, fixture_db: Path) -> None:
        self.fixture_db = fixture_db
        self.dir = Path(tempfile.mkdtemp(prefix="pkm-perf-"))
        (self.dir / "assets").mkdir()
        self.tracer = Tracer()
        self.db = self.dir / "pkm.sqlite3"
        self.fresh()
        self.client = make_client(self.db, self.tracer)

    def fresh(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            Path(f"{self.db}{suffix}").unlink(missing_ok=True)
        shutil.copyfile(self.fixture_db, self.db)

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


def _count_once(env: _Env, s: Scenario, tables: set[str]) -> dict:
    if s.writes:
        env.fresh()
    env.tracer.start()
    r = _call(env.client, s)
    tally = env.tracer.stop()
    con = sqlite3.connect(env.db)
    try:
        scans = 0
        for sql in dict.fromkeys(q for q in tally.statements if plannable(q)):
            try:
                rows = con.execute(f"EXPLAIN QUERY PLAN {sql}").fetchall()
            except sqlite3.Error:
                continue  # e.g. a statement referencing a temp table gone by now
            scans += len(full_scans((row[3] for row in rows), tables))
    finally:
        con.close()
    return {"statements": len(tally.statements), "trigger_statements": tally.trigger_statements,
            "vm_steps_k": tally.ticks, "bytes": len(r.content), "full_scans": scans}


def _time(env: _Env, s: Scenario, repeats: int) -> float:
    samples = []
    for i in range(repeats + 1):  # first is warm-up
        if s.writes:
            env.fresh()
        t0 = time.perf_counter()
        _call(env.client, s)
        if i:
            samples.append((time.perf_counter() - t0) * 1000)
    return round(statistics.median(samples), 2)


def run(fixture_db: Path, *, only: set[str] | None = None, repeats: int = 5,
        scale: float = 1.0, commit: str = "working-tree") -> dict:
    fx = generate(1, scale)
    con = sqlite3.connect(fixture_db)
    max_seq = con.execute("SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    con.close()
    out: dict[str, dict] = {}
    with time_machine.travel(FROZEN_NOW, tick=False):
        env = _Env(fixture_db)
        try:
            for s in scenarios(fx.landmarks, max_seq):
                if only is not None and s.name not in only:
                    continue
                a, b = _count_once(env, s, tables), _count_once(env, s, tables)
                if a != b:
                    raise UnstableCountError(f"{s.name}: counted runs differ: {a} vs {b}")
                metrics = {k: {"class": "exact", "value": v} for k, v in a.items()}
                metrics["median_ms"] = {"class": "timing", "value": _time(env, s, repeats)}
                out[s.name] = metrics
        finally:
            env.close()
    return {"commit": commit, "fixture_hash": fixture_hash(),
            "env": {"python": platform.python_version(), "sqlite": sqlite3.sqlite_version},
            "scenarios": out}


def main() -> int:
    ap = argparse.ArgumentParser(prog="python -m perfcheck.backend")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--commit", default="working-tree")
    a = ap.parse_args()
    only = set(a.only.split(",")) if a.only else None
    result = run(cached_fixture(1, a.scale), only=only, repeats=a.repeats,
                 scale=a.scale, commit=a.commit)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = a.out.with_suffix(".tmp")
    tmp.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    tmp.replace(a.out)  # never a partial result file
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Notes for the implementer:
- `fixture_db` must be built with the same `scale` passed to `run` (landmarks come from `generate(1, scale)`).
- If a scenario returns non-200 on the small fixture, fix the scenario (wrong param, a landmark that doesn't exist at scale 0.02 — e.g. `page/hub-deep` offset beyond the backlink count is still 200), not the route.
- `time_machine.travel(..., tick=False)` freezes `time.time()` and `date.today()` for the app; `time.perf_counter()` is unaffected, so timings are real.

- [ ] **Step 7: Run tests**

Run: `cd server && uv run pytest tests/test_perfcheck_sqlplan.py tests/test_perfcheck_backend.py -q`
Expected: PASS. If `test_trace_sees_expanded_sql` fails, the interpreter passes unexpanded SQL: stop and report (EXPLAIN would then need bound parameters and the design changes).

- [ ] **Step 8: Full-scale smoke**

Run: `cd server && TZ=Europe/London PYTHONPATH=tooling uv run python -m perfcheck.backend --out ../perf/out/result-backend.json`
Expected: exits 0; the file lists every scenario. Eyeball `full_scans` and `vm_steps_k` for `titles/infix` (LIKE '%x%' should show a scan) — a sanity check that the plan analysis works.

- [ ] **Step 9: Lint, types, commit**

```bash
cd server && uv run pyrefly check && uv run ruff check
git add server/tooling/perfcheck/{sqlplan,trace,backend}.py server/tests/test_perfcheck_{sqlplan,backend}.py
git commit -m "perf(<id>): backend check -- traced statements, VM steps, full scans, timings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: e2e server can serve the fixture under a frozen clock

**Files:**
- Modify: `server/tests/e2e_serve.py`
- Test: `server/tests/test_e2e_serve_options.py`

**Interfaces:**
- Produces (Task 7): env vars read by `e2e_serve.py`:
  - `E2E_FROM_DB=<path>` — copy this DB into the temp data dir instead of creating an empty one
  - `E2E_FROZEN_NOW=<ISO datetime>` — run the server inside `time_machine.travel(<dt>, tick=True)`
  - `E2E_WEB_DIST=<path>` — serve this `web/dist` instead of the repo's own (merge-base runs)
  - Existing: `E2E_PORT`
- New helper: `prepare_db(data: Path, from_db: Path | None) -> Path`

- [ ] **Step 1: Failing test**

```python
# server/tests/test_e2e_serve_options.py
import sqlite3

import e2e_serve


def test_prepare_db_empty(tmp_path):
    db = e2e_serve.prepare_db(tmp_path, None)
    con = sqlite3.connect(db)
    assert con.execute("SELECT COUNT(*) FROM blocks").fetchone()[0] == 0


def test_prepare_db_copies_source(tmp_path):
    src = e2e_serve.prepare_db(tmp_path / "seed", None)
    con = sqlite3.connect(src)
    con.execute("INSERT INTO pages(id, title) VALUES (1, 'Copied')")
    con.commit()
    con.close()
    db = e2e_serve.prepare_db(tmp_path / "data", src)
    assert sqlite3.connect(db).execute("SELECT title FROM pages").fetchone()[0] == "Copied"
    assert db.parent == tmp_path / "data" and db != src
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && uv run pytest tests/test_e2e_serve_options.py -q` → FAIL (`prepare_db` missing).

- [ ] **Step 3: Implement**

In `e2e_serve.py`, extract the DB creation lines in `main()` into:

```python
def prepare_db(data: Path, from_db: Path | None) -> Path:
    """Fresh empty DB, or a private copy of `from_db` (the perf fixture)."""
    data.mkdir(parents=True, exist_ok=True)
    db_path = data / "pkm.sqlite3"
    if from_db is not None:
        shutil.copyfile(from_db, db_path)
    else:
        con = sqlite3.connect(db_path)
        con.executescript(DDL)
        con.commit()
        con.close()
    init_db(db_path)  # WAL + migrations, once, before serving
    return db_path
```

and in `main()`:

```python
    web_dist = Path(os.environ["E2E_WEB_DIST"]) if os.environ.get("E2E_WEB_DIST") else root / "web" / "dist"
    ...
    from_db = os.environ.get("E2E_FROM_DB")
    db_path = prepare_db(data, Path(from_db) if from_db else None)
    ...
    run = lambda: uvicorn.run(app, host="127.0.0.1", port=PORT, log_config=_log_config(log_path))
    frozen = os.environ.get("E2E_FROZEN_NOW")
    if frozen:
        import time_machine
        with time_machine.travel(datetime.fromisoformat(frozen), tick=True):
            run()
    else:
        run()
    return 0
```

(add `from datetime import datetime`). Update the module docstring: one sentence each for `E2E_FROM_DB`, `E2E_FROZEN_NOW`, `E2E_WEB_DIST`, noting they exist for the perf check (`perfcheck.run`).

- [ ] **Step 4: Run tests and the existing e2e smoke**

Run: `cd server && uv run pytest tests/test_e2e_serve_options.py -q` → PASS.
Run: `cd web && pnpm e2e` → the existing suite still passes (defaults unchanged). Known load-sensitive flakes are listed in the web-e2e memory/README; rerun a failing spec alone before blaming this change.

- [ ] **Step 5: Commit**

```bash
git add server/tests/e2e_serve.py server/tests/test_e2e_serve_options.py
git commit -m "perf(<id>): e2e_serve can start from a fixture DB, frozen clock, other dist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend check (`check.mjs`), shared harness, replica-ready mark

**Files:**
- Create: `web/tooling/perf/harness.mjs`
- Modify: `web/tooling/perf/perf.mjs` (import helpers from `harness.mjs`; behaviour unchanged)
- Create: `web/tooling/perf/check.mjs`
- Modify: `web/src/sync/replicaSync.ts` (one `performance.mark`)
- Test: `web/src/sync/replicaSync.test.ts` (add one case; find the existing test file for replicaSync with `ls web/src/sync/*replicaSync*.test.ts`)

**Interfaces:**
- Consumes: server started by Task 7 with `E2E_FROM_DB`, `E2E_FROZEN_NOW`; fixture constants `BIG_PAGE = "Perf Big Page"`, `COMMON_TERM`, `RARE_TERM`
- Produces (Task 7): `node web/tooling/perf/check.mjs --out <file> [--only H,S,...]` with env `PERF_FROZEN_NOW` (ISO), `PERF_FIXTURE_HASH`, `PERF_COMMIT`, `E2E_PORT` (default 8977). Writes a result document (Task 1 shape) with `env = {"chromium": <browser.version()>, "node": <process.version>}`. Exit non-zero and write nothing on any scenario error.
- Scenario ids: `H` (cold), `W` (warm; the spec's H′), `A`, `B`, `F`, `J`, `I`, `K`, `S`. Scenario names in the result: `H/cold`, `W/warm`, `A/idle-big`, `B/idle-journal`, `F/typing`, `J/journal-typing`, `I/journal-scroll`, `K/drag-top`, `K/drag-bottom`, `S/search-common`, `S/search-rare`.

- [ ] **Step 1: Replica-ready mark (TDD)**

Find the site in `web/src/sync/replicaSync.ts` where `doStart` sets the started flag (the one `hasStarted()` reads) and calls `onState({ mode: "ready" })`. Add a failing test to the replicaSync test file, modelled on its existing "emits ready" case:

```ts
it("marks pkm:replica-ready once the first start completes", async () => {
  const mark = vi.spyOn(performance, "mark");
  // ...start the replica sync exactly as the existing ready-state test does...
  expect(mark).toHaveBeenCalledWith("pkm:replica-ready");
  mark.mockRestore();
});
```

Run: `cd web && pnpm vitest run src/sync/replicaSync` → FAIL. Then add, immediately before that `onState({ mode: "ready" })` in `doStart`:

```ts
      // Read by web/tooling/perf/check.mjs to time replica readiness.
      performance.mark?.("pkm:replica-ready");
```

Run again → PASS. Run `cd web && pnpm typecheck && pnpm lint`.

- [ ] **Step 2: Extract `harness.mjs`**

Move these from `perf.mjs` verbatim into `web/tooling/perf/harness.mjs` and `export` them: `HERE`, `PORT`, `BASE`, `PASSWORD`, `BIG_PAGE`, `INIT`, `REACT_INIT`, `sleep`, `attachCounters`, `freshBag`, `resetBag`, `login`. Header:

```js
// pattern: Imperative Shell
// Shared Playwright helpers for perf.mjs (investigation) and check.mjs (gate).
```

In `perf.mjs`, replace the moved definitions with:

```js
import { HERE, PORT, BASE, PASSWORD, BIG_PAGE, INIT, REACT_INIT, sleep,
         attachCounters, freshBag, resetBag, login } from "./harness.mjs";
```

Verify: `node --check web/tooling/perf/perf.mjs web/tooling/perf/harness.mjs`.

- [ ] **Step 3: Write `check.mjs`**

```js
// pattern: Imperative Shell
// Gated frontend perf check (spec: docs/superpowers/specs/2026-09-26-perf-regression-checks-design.md).
// Headless, counts first. Run through perfcheck.run, which starts the fixture
// server on 8977 and sets PERF_FROZEN_NOW / PERF_FIXTURE_HASH / PERF_COMMIT.
// Every metric declares its class here; changing one is a reviewed change.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { BASE, BIG_PAGE, INIT, REACT_INIT, sleep, attachCounters, freshBag,
         login } from "./harness.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const OUT = arg("--out");
const ONLY = new Set((arg("--only", "H,W,A,B,F,J,I,K,S")).split(","));
const FROZEN = process.env.PERF_FROZEN_NOW;
if (!OUT || !FROZEN) { console.error("need --out and PERF_FROZEN_NOW"); process.exit(2); }
const IDLE_MS = 30_000;

const ex = (value) => ({ class: "exact", value });
const band = (value) => ({ class: "band", value });
const tm = (value) => ({ class: "timing", value: +value.toFixed(1) });
const scenarios = {};

async function newContext(browser, { react = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.clock.install({ time: new Date(FROZEN) });   // time flows from FROZEN
  await ctx.addInitScript(INIT);
  if (react) await ctx.addInitScript(REACT_INIT);
  return ctx;
}

async function openPage(ctx) {
  const page = await ctx.newPage();
  const bag = freshBag();
  attachCounters(page, bag);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  return { page, bag, cdp };
}

const layoutCount = async (cdp) =>
  (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "LayoutCount").value;

async function replicaReadyMs(page) {
  await page.waitForFunction(() => performance.getEntriesByName("pkm:replica-ready").length > 0,
                             null, { timeout: 120_000 });
  return page.evaluate(() => performance.getEntriesByName("pkm:replica-ready")[0].startTime);
}

const apiBytes = (page) => page.evaluate(() => performance.getEntriesByType("resource")
  .filter((r) => new URL(r.name).pathname.startsWith("/api/"))
  .reduce((s, r) => s + (r.encodedBodySize || 0), 0));

const count = (bag, p) => bag.requests[p] ?? 0;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
                "August", "September", "October", "November", "December"];
const suffix = (d) => (d % 100 >= 10 && d % 100 <= 20) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[d % 10] ?? "th");
const dailyTitle = (dt) => `${MONTHS[dt.getMonth()]} ${dt.getDate()}${suffix(dt.getDate())}, ${dt.getFullYear()}`;

async function assertFrozenToday(page) {
  // The fixture's newest journal day is FROZEN's date (TZ=Europe/London); if
  // the browser clock were real, the journal would open on an empty "today".
  const want = dailyTitle(new Date(FROZEN));
  const first = await page.locator("section.journal-day").first().innerText();
  if (!first.includes(want)) {
    throw new Error(`browser clock not frozen: want ${want}, first journal day reads ${JSON.stringify(first.slice(0, 40))}`);
  }
}

async function cold({ page, bag }) {
  await login(page);
  const readyMs = await replicaReadyMs(page);
  await page.waitForLoadState("networkidle");
  await assertFrozenToday(page);
  scenarios["H/cold"] = {
    requests: ex(bag.requestTotal),
    api_bytes: ex(await apiBytes(page)),
    snapshot_requests: ex(count(bag, "/api/sync/snapshot")),
    changes_requests: ex(count(bag, "/api/sync/changes")),
    replica_ready_ms: tm(readyMs),
  };
}

async function warm({ page, bag }) {
  for (const k of Object.keys(bag.requests)) delete bag.requests[k];
  bag.requestTotal = 0;
  await page.goto(BASE + "/page/" + encodeURIComponent(BIG_PAGE));
  await page.waitForSelector("div.block-text", { timeout: 30_000 });
  const paintMs = await page.evaluate(() => performance.now());
  await page.waitForLoadState("networkidle");
  scenarios["W/warm"] = {
    requests: ex(bag.requestTotal),
    changes_requests: ex(count(bag, "/api/sync/changes")),
    snapshot_requests: ex(count(bag, "/api/sync/snapshot")),
    first_outline_ms: tm(paintMs),
  };
}

async function idle(page, name, url, readySel) {
  await page.goto(BASE + url);
  await page.waitForSelector(readySel, { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.__perfReset());
  await sleep(IDLE_MS);
  const p = await page.evaluate(() => JSON.parse(JSON.stringify(window.__perf)));
  scenarios[name] = {
    timers_armed: band(p.st + p.si),
    fetches: band(p.fetch + p.xhr),
    ws_opens: ex(p.ws),
    long_tasks: band(p.longtasks),
  };
}

async function typeInto(page, cdp, rootSel, text, target) {
  await target.click();
  await page.waitForSelector("textarea.block-input", { timeout: 10_000 });
  await page.locator("textarea.block-input").evaluate((el) =>
    el.setSelectionRange(el.value.length, el.value.length));
  await page.evaluate((sel) => { window.__perfReset(); window.__reactReset?.();
                                 window.__perfMutStart(sel); }, rootSel);
  const l0 = await layoutCount(cdp);
  // 120 ms per key: well inside the 500 ms text debounce, so it fires once.
  await page.keyboard.type(text, { delay: 120 });
  await sleep(2000);
  const l1 = await layoutCount(cdp);
  const p = await page.evaluate(() => { window.__perfMutStop();
                                        return JSON.parse(JSON.stringify(window.__perf)); });
  const r = await page.evaluate(() => window.__react ? { ...window.__react } : null);
  await page.keyboard.press("Escape");
  return { layouts: l1 - l0, p, r };
}

const TYPED = "perf check typing probe, fifty characters exactly!".slice(0, 50);

async function typing({ page, cdp }) {
  await page.goto(BASE + "/page/" + encodeURIComponent(BIG_PAGE));
  await page.waitForSelector("div.block-text", { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  // nth(10): an ordinary text block, clear of the mermaid/katex/code blocks
  // the fixture puts at the top of the big page.
  const { layouts, p } = await typeInto(page, cdp, ".outline, main, #root", TYPED,
                                        page.locator("div.block-text").nth(10));
  scenarios["F/typing"] = { forced_layouts: band(layouts), mut_outside: ex(p.mutOutside),
                            fetches: ex(p.fetch + p.xhr) };
}

async function journalScroll({ page, bag }) {
  await page.goto(BASE + "/");
  await page.waitForSelector("section.journal-day", { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  for (const k of Object.keys(bag.requests)) delete bag.requests[k];
  for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 600); await sleep(250); }
  await page.waitForLoadState("networkidle");
  const pageFetches = Object.entries(bag.requests)
    .filter(([k]) => k.startsWith("/api/page/")).reduce((s, [, n]) => s + n, 0);
  scenarios["I/journal-scroll"] = {
    days_loaded: ex(await page.locator("section.journal-day").count()),
    journal_requests: ex(count(bag, "/api/journal")),
    page_requests: ex(pageFetches),
  };
}

async function journalTyping({ page, cdp }) {
  await page.goto(BASE + "/");
  await page.waitForSelector("section.journal-day", { timeout: 30_000 });
  // Mount at least 30 days (a fixed target, so the count is repeatable).
  for (let i = 0; i < 60 && (await page.locator("section.journal-day").count()) < 30; i++) {
    await page.mouse.wheel(0, 6000); await sleep(500);
  }
  await page.waitForLoadState("networkidle");
  const days = await page.locator("section.journal-day").count();
  const { r } = await typeInto(page, cdp, ".journal, main, #root", TYPED,
                               page.locator("section.journal-day div.block-text").first());
  scenarios["J/journal-typing"] = { days_mounted: ex(days), react_commits: band(r.commits),
                                    rendered_fibers: band(r.rendered) };
}

async function drag({ page, cdp }, name, fromBottom) {
  await page.goto(BASE + "/page/" + encodeURIComponent(BIG_PAGE));
  await page.waitForSelector("div.block-text", { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  if (fromBottom) {
    await page.locator(".outline-drop-zone [data-uid]").last().scrollIntoViewIfNeeded();
    await sleep(1000);
  }
  await page.evaluate(() => window.__reactReset?.());
  const l0 = await layoutCount(cdp);
  const d = await page.evaluate(async ({ events, paceMs }) => {
    const zone = document.querySelector(".outline-drop-zone");
    const handle = zone?.querySelector('[data-uid] .bullet[draggable="true"]');
    if (!zone || !handle) return { error: "no drop zone / drag handle" };
    const transfer = new DataTransfer();
    const fire = (el, type, x, y) => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y,
                                       dataTransfer: transfer });
      const t0 = performance.now(); el.dispatchEvent(ev);
      return { ms: performance.now() - t0, prevented: ev.defaultPrevented };
    };
    fire(handle, "dragstart", 40, 120);
    await new Promise((r) => setTimeout(r, 100));
    const top = 80, bottom = window.innerHeight - 40, ms = [];
    let notPrevented = 0;
    for (let i = 0; i < events; i++) {
      const got = fire(zone, "dragover", 200, top + ((bottom - top) * i) / (events - 1));
      ms.push(got.ms); if (!got.prevented) notPrevented++;
      await new Promise((r) => setTimeout(r, paceMs));
    }
    fire(handle, "dragend", 200, bottom);
    return { meanMs: ms.reduce((s, v) => s + v, 0) / ms.length, notPrevented };
  }, { events: 120, paceMs: 16 });
  if (d.error) throw new Error(`${name}: ${d.error}`);
  await sleep(1500);
  const r = await page.evaluate(() => ({ ...window.__react }));
  scenarios[name] = { not_prevented: ex(d.notPrevented), react_commits: band(r.commits),
                      forced_layouts: band((await layoutCount(cdp)) - l0),
                      handler_ms: tm(d.meanMs) };
}

async function search({ page, bag }, name, term) {
  await page.goto(BASE + "/");
  await page.waitForSelector("section.journal-day", { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  const input = page.locator("input.top-bar-search-input");
  await input.click();
  for (const k of Object.keys(bag.requests)) delete bag.requests[k];
  await page.evaluate(() => { window.__perfReset(); window.__reactReset?.(); });
  await input.pressSequentially(term, { delay: 150 });
  const t0 = Date.now();
  await page.waitForSelector("li.search-result mark", { timeout: 15_000 });
  const resultsMs = Date.now() - t0;
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  // Open a real block hit by clicking it: Enter on the synthetic
  // `Create page "…"` row would write to the DB mid-run.
  await page.locator("li.search-result:has(mark)").first().click();
  await page.waitForLoadState("networkidle");
  const p = await page.evaluate(() => JSON.parse(JSON.stringify(window.__perf)));
  const r = await page.evaluate(() => ({ ...window.__react }));
  scenarios[name] = {
    search_requests: ex(count(bag, "/api/search")),
    fetches: ex(p.fetch + p.xhr),
    react_commits: band(r.commits),
    results_ms: tm(resultsMs),
  };
}

const any = (...ids) => ids.some((id) => ONLY.has(id));

async function loggedIn(browser, opts) {
  const ctx = await newContext(browser, opts);
  const st = await openPage(ctx);
  await login(st.page);
  await replicaReadyMs(st.page);
  return { ctx, st };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    // H and W share a fresh context: H is its first (empty-replica) load,
    // W the next navigation once replica and service worker are warm.
    if (any("H", "W")) {
      const ctx = await newContext(browser);
      const st = await openPage(ctx);
      await cold(st);
      if (ONLY.has("W")) await warm(st);
      if (!ONLY.has("H")) delete scenarios["H/cold"];
      await ctx.close();
    }
    // No React hook here: it walks the fiber tree on every commit and would
    // distort idle and typing behaviour.
    if (any("A", "B", "F", "I")) {
      const { ctx, st } = await loggedIn(browser);
      if (ONLY.has("A")) await idle(st.page, "A/idle-big", "/page/" + encodeURIComponent(BIG_PAGE), "div.block-text");
      if (ONLY.has("B")) await idle(st.page, "B/idle-journal", "/", "section.journal-day");
      if (ONLY.has("F")) await typing(st);
      if (ONLY.has("I")) await journalScroll(st);
      await ctx.close();
    }
    // React-hook context for commit counts (J, K, S).
    if (any("J", "K", "S")) {
      const { ctx, st } = await loggedIn(browser, { react: true });
      if (ONLY.has("J")) await journalTyping(st);
      if (ONLY.has("K")) { await drag(st, "K/drag-top", false); await drag(st, "K/drag-bottom", true); }
      if (ONLY.has("S")) { await search(st, "S/search-common", "project");
                           await search(st, "S/search-rare", "zyxquark"); }
      await ctx.close();
    }
    const doc = { commit: process.env.PERF_COMMIT ?? "working-tree",
                  fixture_hash: process.env.PERF_FIXTURE_HASH ?? "unknown",
                  env: { chromium: browser.version(), node: process.version }, scenarios };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT + ".tmp", JSON.stringify(doc, null, 2) + "\n");
    fs.renameSync(OUT + ".tmp", OUT);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Implementer notes:
- **Clock verification is the first thing to get right.** `ctx.clock.install({ time })` fakes `Date` and timers but lets time flow. `assertFrozenToday` proves the journal opens on the fixture's newest day. Also confirm that the `A/idle-big` `timers_armed` is non-zero (instrument.js still sees timers under the fake clock). If `clock.install` breaks sync (the replica never becomes ready) or leaves `timers_armed` at 0, **stop and report**; do not switch to `setFixedTime` silently (it stops `Date.now` advancing, which breaks backoff and debounce maths).
- The `/` route after login is the journal; `login()` waits for `**/`.
- Each run gets a fresh server on a fresh copy of the fixture (Task 7), so writes made by typing scenarios never leak into the next run.

- [ ] **Step 4: Smoke against a fixture server**

```bash
FX=$(cd server && PYTHONPATH=tooling uv run python -c "from perfcheck.build import cached_fixture; print(cached_fixture())")
cd web && CI=true pnpm build && cd ..
(cd server && TZ=Europe/London E2E_PORT=8977 E2E_FROM_DB="$FX" E2E_FROZEN_NOW=2026-06-15T12:00:00+01:00 \
   uv run python tests/e2e_serve.py) &
sleep 5
TZ=Europe/London PERF_FROZEN_NOW=2026-06-15T12:00:00+01:00 node web/tooling/perf/check.mjs --out perf/out/result-frontend.json
pkill -f tests/e2e_serve.py
```

Expected: exit 0; `perf/out/result-frontend.json` has all eleven scenario names; `H/cold.snapshot_requests.value >= 1`; `S/search-common.search_requests` recorded (0 is a legitimate answer if the replica serves search locally — record what it is).

Also re-run the investigation harness once to prove the extraction didn't break it: `cd web/tooling/perf && DUR=5000 HEADLESS=1 node perf.mjs A` against the same server → prints the `[A idle big page]` line.

- [ ] **Step 5: Commit**

```bash
git add web/tooling/perf/{harness,check,perf}.mjs web/src/sync/replicaSync.ts web/src/sync/*replicaSync*.test.ts
git commit -m "perf(<id>): gated frontend check.mjs; shared harness; replica-ready mark

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Orchestrator (`perfcheck.run`) and `perf/check.sh`

**Files:**
- Create: `server/tooling/perfcheck/run_core.py` (Functional Core)
- Create: `server/tooling/perfcheck/run.py` (Imperative Shell)
- Create: `perf/check.sh`
- Test: `server/tests/test_perfcheck_run.py`

**Interfaces:**
- Consumes: everything above. Backend: `python -m perfcheck.backend --out F [--only …] --commit SHA`. Frontend: `e2e_serve.py` env vars (Task 5), `check.mjs` CLI/env (Task 6). Compare API (Task 1).
- Produces:
  - `run_core.sides_for(paths: Iterable[str]) -> list[str]` → subset of `["backend", "frontend"]` in that order
  - `run_core.scenarios_of(findings) -> list[str]`
  - `run_core.exit_code(comparison, outcomes) -> int` — 0 when no `regression`/`unstable`/`stale-baseline` outcome and no blocking finding, else 1
  - `run_core.frontend_letters(scenario_names) -> str` — `"K/drag-top" -> "K"`, comma-joined unique letters
  - `run.BackendRunner(repo: Path)` / `run.FrontendRunner(repo: Path)` each with `.run(worktree: Path, only: list[str] | None, commit: str) -> dict`
  - `run.merge_base_worktree(repo: Path, side: str) -> tuple[Path, str]` — cached detached worktree at `cache_dir()/worktrees/<sha>`; for the frontend it runs `pnpm install --frozen-lockfile` and `CI=true pnpm build` once (marker file `.perf-built`)
  - CLI: `perf/check.sh [auto|backend|frontend] [--bootstrap] [--rebaseline] [--runs N]` (default `auto`, runs 5)

- [ ] **Step 1: Failing tests (pure parts + the Review Focus cases)**

```python
# server/tests/test_perfcheck_run.py
import socket
from pathlib import Path

import pytest

from perfcheck import run, run_core
from perfcheck.compare import Comparison, Finding


def test_sides_for():
    assert run_core.sides_for(["server/src/pkm/server/routes_pages.py"]) == ["backend"]
    assert run_core.sides_for(["web/src/App.tsx"]) == ["frontend"]
    assert run_core.sides_for(["web/x.ts", "server/y.py"]) == ["backend", "frontend"]
    assert run_core.sides_for(["docs/architecture/frontend.md", "AGENTS.md"]) == []
    assert run_core.sides_for(["perf/baseline-backend.json"]) == []


def test_frontend_letters():
    assert run_core.frontend_letters(["K/drag-top", "K/drag-bottom", "S/search-rare"]) == "K,S"


def test_exit_code():
    ok = Comparison((Finding("s", "n", "improvement", "2", "1"),), {})
    assert run_core.exit_code(ok, {}) == 0
    reg = Comparison((Finding("s", "n", "candidate", "1", "2"),), {})
    assert run_core.exit_code(reg, {("s", "n"): "regression"}) == 1
    assert run_core.exit_code(reg, {("s", "n"): "unstable"}) == 1
    lost = Comparison((Finding("s", "*", "lost", "present", "missing"),), {})
    assert run_core.exit_code(lost, {}) == 1


def test_sides_include_untracked(tmp_path, monkeypatch):
    monkeypatch.setattr(run, "_git", lambda repo, *a: {
        ("merge-base", "HEAD", "main"): "abc\n",
        ("diff", "--name-only", "abc"): "server/a.py\n",
        ("ls-files", "--others", "--exclude-standard"): "web/new.ts\n",
    }[a])
    assert run.changed_paths(tmp_path) == ["server/a.py", "web/new.ts"]


def test_merge_base_command_uses_branch_harness(tmp_path):
    repo, wt = tmp_path / "repo", tmp_path / "wt"
    cmd, env = run.BackendRunner(repo).command(wt, ["page/big"], "abc", tmp_path / "out.json")
    assert cmd[:4] == ["uv", "run", "--project", str(wt / "server")]
    assert env["PYTHONPATH"] == str(repo / "server" / "tooling")
    fcmd, fenv = run.FrontendRunner(repo).server_command(wt, Path("/fx.sqlite3"))
    assert str(repo / "server" / "tests" / "e2e_serve.py") in fcmd
    assert fenv["E2E_WEB_DIST"] == str(wt / "web" / "dist")


def test_port_busy_fails_without_result(tmp_path):
    s = socket.socket()
    s.bind(("127.0.0.1", run.FRONTEND_PORT))
    s.listen(1)
    try:
        out = tmp_path / "r.json"
        with pytest.raises(run.PerfRunError, match=str(run.FRONTEND_PORT)):
            run.FrontendRunner(tmp_path).ensure_port_free()
        assert not out.exists()
    finally:
        s.close()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && uv run pytest tests/test_perfcheck_run.py -q` → FAIL (modules missing).

- [ ] **Step 3: Implement `run_core.py`**

```python
# server/tooling/perfcheck/run_core.py
# pattern: Functional Core
"""Decisions for the perf orchestrator: which sides a diff touches, which
scenarios to re-run, and the exit code."""
from __future__ import annotations

from collections.abc import Iterable, Mapping

from perfcheck.compare import Comparison, Outcome

_SIDES = (("backend", ("server/",)), ("frontend", ("web/",)))


def sides_for(paths: Iterable[str]) -> list[str]:
    paths = list(paths)
    return [side for side, prefixes in _SIDES
            if any(p.startswith(prefixes) for p in paths)]


def scenarios_of(findings: Iterable) -> list[str]:
    return sorted({f.scenario for f in findings})


def frontend_letters(names: Iterable[str]) -> str:
    return ",".join(sorted({n.split("/", 1)[0] for n in names}))


def exit_code(c: Comparison, outcomes: Mapping[tuple[str, str], Outcome]) -> int:
    return 1 if c.blocking or outcomes else 0
```

Note `exit_code`: every confirmed candidate gets *some* outcome, and all three outcomes need attention (fix code / fix harness / rebaseline), so any outcome means non-zero.

- [ ] **Step 4: Implement `run.py`**

```python
# server/tooling/perfcheck/run.py
# pattern: Imperative Shell
"""perf/check.sh entry point: run the side(s) a diff touches, compare with the
committed baseline, confirm candidates (re-run, then merge base), write
ratcheted baselines, print the table.

Merge-base runs use this branch's harness (perfcheck, check.mjs,
e2e_serve.py) against the merge base's product code (pkm package, web/dist),
so they work even when the merge base predates this tooling."""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from perfcheck.build import cache_dir, fixture_hash
from perfcheck.compare import (bootstrap, compare, confirm, incomparable_reason,
                               render_table)
from perfcheck.fixture import FROZEN_NOW
from perfcheck.run_core import exit_code, frontend_letters, scenarios_of, sides_for

FRONTEND_PORT = 8977
TZ = "Europe/London"


class PerfRunError(RuntimeError):
    pass


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True,
                          capture_output=True, text=True).stdout


def repo_root() -> Path:
    return Path(_git(Path.cwd(), "rev-parse", "--show-toplevel").strip())


def changed_paths(repo: Path) -> list[str]:
    base = _git(repo, "merge-base", "HEAD", "main").strip()
    tracked = _git(repo, "diff", "--name-only", base).split()
    untracked = _git(repo, "ls-files", "--others", "--exclude-standard").split()
    return sorted(set(tracked) | set(untracked))


def head_commit(repo: Path) -> str:
    dirty = _git(repo, "status", "--porcelain").strip()
    sha = _git(repo, "rev-parse", "--short", "HEAD").strip()
    return f"{sha}+dirty" if dirty else sha


def _base_env() -> dict[str, str]:
    return {**os.environ, "TZ": TZ}


class BackendRunner:
    def __init__(self, repo: Path) -> None:
        self.repo = repo

    def command(self, worktree: Path, only: list[str] | None, commit: str,
                out: Path) -> tuple[list[str], dict[str, str]]:
        cmd = ["uv", "run", "--project", str(worktree / "server"), "python", "-m",
               "perfcheck.backend", "--out", str(out), "--commit", commit]
        if only:
            cmd += ["--only", ",".join(only)]
        return cmd, {**_base_env(), "PYTHONPATH": str(self.repo / "server" / "tooling")}

    def run(self, worktree: Path, only: list[str] | None, commit: str) -> dict:
        out = self.repo / "perf" / "out" / "result-backend.json"
        out.unlink(missing_ok=True)
        cmd, env = self.command(worktree, only, commit, out)
        subprocess.run(cmd, check=True, env=env, cwd=worktree / "server")
        return json.loads(out.read_text())


class FrontendRunner:
    def __init__(self, repo: Path) -> None:
        self.repo = repo
        self._built = False

    def ensure_port_free(self) -> None:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", FRONTEND_PORT)) == 0:
                raise PerfRunError(f"port {FRONTEND_PORT} is in use; stop whatever holds it "
                                   "(never use 8974/8975 instead)")

    def fixture_path(self, worktree: Path) -> Path:
        out = subprocess.run(
            ["uv", "run", "--project", str(worktree / "server"), "python", "-c",
             "from perfcheck.build import cached_fixture; print(cached_fixture())"],
            check=True, capture_output=True, text=True,
            env={**_base_env(), "PYTHONPATH": str(self.repo / "server" / "tooling")})
        return Path(out.stdout.strip())

    def server_command(self, worktree: Path, fixture: Path) -> tuple[list[str], dict[str, str]]:
        cmd = ["uv", "run", "--project", str(worktree / "server"), "python",
               str(self.repo / "server" / "tests" / "e2e_serve.py")]
        env = {**_base_env(), "E2E_PORT": str(FRONTEND_PORT), "E2E_FROM_DB": str(fixture),
               "E2E_FROZEN_NOW": FROZEN_NOW.isoformat(),
               "E2E_WEB_DIST": str(worktree / "web" / "dist"),
               "PYTHONPATH": str(self.repo / "server" / "tooling")}
        return cmd, env

    def run(self, worktree: Path, only: list[str] | None, commit: str) -> dict:
        self.ensure_port_free()
        if worktree == self.repo and not self._built:
            subprocess.run(["pnpm", "build"], check=True, cwd=self.repo / "web",
                           env={**_base_env(), "CI": "true"})
            self._built = True
        fixture = self.fixture_path(worktree)
        cmd, env = self.server_command(worktree, fixture)
        server = subprocess.Popen(cmd, env=env, cwd=self.repo / "server")
        out = self.repo / "perf" / "out" / "result-frontend.json"
        out.unlink(missing_ok=True)
        try:
            self._wait_healthy(server)
            node = ["node", str(self.repo / "web" / "tooling" / "perf" / "check.mjs"), "--out", str(out)]
            if only:
                node += ["--only", frontend_letters(only)]
            subprocess.run(node, check=True, cwd=self.repo / "web", env={
                **_base_env(), "E2E_PORT": str(FRONTEND_PORT),
                "PERF_FROZEN_NOW": FROZEN_NOW.isoformat(),
                "PERF_FIXTURE_HASH": fixture_hash(), "PERF_COMMIT": commit})
        finally:
            server.terminate()
            server.wait(timeout=30)
        doc = json.loads(out.read_text())
        if only:  # a letter can cover several scenarios; keep only those asked for
            doc["scenarios"] = {k: v for k, v in doc["scenarios"].items() if k in set(only)}
        return doc

    def _wait_healthy(self, server: subprocess.Popen) -> None:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise PerfRunError(f"fixture server exited with {server.returncode}")
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{FRONTEND_PORT}/healthz", timeout=1)
                return
            except OSError:
                time.sleep(0.5)
        raise PerfRunError("fixture server did not become healthy within 60 s")


def merge_base_worktree(repo: Path, side: str) -> tuple[Path, str]:
    sha = _git(repo, "merge-base", "HEAD", "main").strip()
    wt = cache_dir() / "worktrees" / sha[:12]
    if not wt.exists():
        _git(repo, "worktree", "add", "--detach", str(wt), sha)
    if side == "frontend" and not (wt / ".perf-built").exists():
        subprocess.run(["pnpm", "install", "--frozen-lockfile"], check=True, cwd=wt / "web",
                       env={**_base_env(), "CI": "true"})
        subprocess.run(["pnpm", "build"], check=True, cwd=wt / "web",
                       env={**_base_env(), "CI": "true"})
        (wt / ".perf-built").touch()
    return wt, sha[:7]


def _runner(repo: Path, side: str):
    return BackendRunner(repo) if side == "backend" else FrontendRunner(repo)


def _baseline_path(repo: Path, side: str) -> Path:
    return repo / "perf" / f"baseline-{side}.json"


def _write(path: Path, doc: dict) -> None:
    path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n")


def do_bootstrap(repo: Path, side: str, runs: int, at_merge_base: bool) -> int:
    runner = _runner(repo, side)
    wt, commit = merge_base_worktree(repo, side) if at_merge_base else (repo, head_commit(repo))
    docs = [runner.run(wt, None, commit) for _ in range(runs)]
    base, unstable = bootstrap(docs)
    if base is None:
        print(f"## {side}: {len(unstable)} unstable metric(s) — reconcile before recording a baseline\n")
        for u in unstable:
            print(f"- {u.scenario} {u.metric}: {list(u.values)}")
        print("\nSee the spec's Determinism section: fix the source in the harness first; "
              "reclassify to band only if the variation is inherent.")
        return 1
    _write(_baseline_path(repo, side), base)
    print(f"## {side}: baseline written from {runs} runs at {commit}")
    return 0


def do_check(repo: Path, side: str) -> int:
    path = _baseline_path(repo, side)
    if not path.exists():
        print(f"## {side}: no baseline — run `perf/check.sh {side} --bootstrap`")
        return 1
    baseline = json.loads(path.read_text())
    runner = _runner(repo, side)
    result = runner.run(repo, None, head_commit(repo))
    reason = incomparable_reason(baseline, result)
    if reason:
        print(f"## {side}: cannot compare — {reason}.\n"
              f"Run `perf/check.sh {side} --rebaseline`, then check again.")
        return 1
    c = compare(baseline, result)
    outcomes = {}
    if c.candidates:
        names = scenarios_of(c.candidates)
        rerun = runner.run(repo, names, head_commit(repo))
        survivors = [f for f in c.candidates
                     if confirm(baseline, [f], rerun, None)[(f.scenario, f.metric)] == "regression"]
        mb = None
        if survivors:
            wt, mb_commit = merge_base_worktree(repo, side)
            mb = runner.run(wt, scenarios_of(survivors), mb_commit)
        outcomes = confirm(baseline, c.candidates, rerun, mb)
    if c.new_baseline != baseline:
        _write(path, c.new_baseline)
    print(f"## perf: {side}\n")
    print(render_table(c.findings, outcomes) if c.findings else "no changes against the baseline")
    if c.new_baseline != baseline:
        print(f"\nbaseline updated: {path.relative_to(repo)} — commit it with this change")
    return exit_code(c, outcomes)


def main() -> int:
    ap = argparse.ArgumentParser(prog="perf/check.sh")
    ap.add_argument("side", nargs="?", default="auto", choices=["auto", "backend", "frontend"])
    ap.add_argument("--bootstrap", action="store_true")
    ap.add_argument("--rebaseline", action="store_true")
    ap.add_argument("--runs", type=int, default=5)
    a = ap.parse_args()
    repo = repo_root()
    sides = sides_for(changed_paths(repo)) if a.side == "auto" else [a.side]
    if not sides:
        print("## perf: no backend or frontend changes — nothing to check")
        return 0
    rc = 0
    for side in sides:
        try:
            if a.bootstrap or a.rebaseline:
                rc |= do_bootstrap(repo, side, a.runs, at_merge_base=a.rebaseline)
            else:
                rc |= do_check(repo, side)
        except (PerfRunError, subprocess.CalledProcessError) as e:
            print(f"## perf: {side} failed — {e}", file=sys.stderr)
            rc |= 2
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: `perf/check.sh`**

```bash
#!/usr/bin/env bash
# Perf regression check. Usage: perf/check.sh [auto|backend|frontend] [--bootstrap|--rebaseline] [--runs N]
# Design: docs/superpowers/specs/2026-09-26-perf-regression-checks-design.md
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
cd "$repo/server"
TZ=Europe/London PYTHONPATH="$repo/server/tooling" exec uv run python -m perfcheck.run "$@"
```

`chmod +x perf/check.sh`.

- [ ] **Step 6: Run tests, lint, types**

Run: `cd server && uv run pytest tests/test_perfcheck_run.py -q && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: PASS (full suite too — the new pytest `pythonpath` must not disturb existing tests).

- [ ] **Step 7: Commit**

```bash
git add server/tooling/perfcheck/run_core.py server/tooling/perfcheck/run.py perf/check.sh server/tests/test_perfcheck_run.py
git commit -m "perf(<id>): perf/check.sh orchestrator -- sides, confirm via rerun and merge base

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Bootstrap, reconcile, record baselines

This task is measurement, not code-by-recipe: it runs the tool on the real fixture and fixes whatever instability it reveals. **Run it on the strongest model** (it needs judgement).

**Files:**
- Create: `perf/baseline-backend.json`, `perf/baseline-frontend.json`
- Modify (only as reconciliation requires): `server/tooling/perfcheck/backend.py`, `web/tooling/perf/check.mjs`

- [ ] **Step 1: Backend bootstrap**

Run: `perf/check.sh backend --bootstrap`
Expected on success: `baseline written from 5 runs`. On `unstable metric(s)`: for each listed metric, apply the spec's Determinism table — find the uncontrolled input (clock, background work, first-request setup) and remove it in `backend.py`. Only an inherent variation may be reclassified to `band`, with a one-line comment at the metric's declaration saying why. Re-run until it writes a baseline.

- [ ] **Step 2: Frontend bootstrap**

Run: `perf/check.sh frontend --bootstrap` (takes several minutes: five full passes).
Same reconciliation loop, in `check.mjs`. Typical fixes: wait for `networkidle` before resetting counters; count per event instead of per window; raise the typing pace margin against the debounce. Record every reconciliation (metric, cause, fix) in the commit message.

- [ ] **Step 3: Acceptance — two clean checks on the same commit**

Commit the baselines first (so `head_commit` is clean), then:

Run: `perf/check.sh backend && perf/check.sh backend && perf/check.sh frontend && perf/check.sh frontend`
Expected: each prints `no changes against the baseline` and exits 0. Any `unstable` outcome sends you back to Step 1/2.

- [ ] **Step 4: Prove the gate catches a real regression (then revert)**

Temporarily make `GET /api/page` issue one extra query per backlink (e.g. in `routes_pages._backlinks`, add `for row in rows: db.execute("SELECT 1 FROM pages WHERE id = ?", (page_id,)).fetchone()`). Run `perf/check.sh backend`.
Expected: exits 1; table shows `page/hub | statements | N | N+20 | regression`. Revert with `git checkout -- server/src/pkm/server/routes_pages.py`, run again, expect exit 0.

- [ ] **Step 5: Commit**

```bash
git add perf/baseline-backend.json perf/baseline-frontend.json server/tooling/perfcheck web/tooling/perf
git commit -m "perf(<id>): record first backend and frontend baselines

Reconciled: <metric> — <cause> — <fix>; ...

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Wire the workflow and docs

**Files:**
- Modify: `AGENTS.md` (Testing section)
- Modify: `.claude/skills/verify/SKILL.md` (new "Performance" section) — invoke `superpowers:writing-skills` first (AGENTS.md rule)
- Modify: `web/tooling/perf/README.md`
- Modify: `docs/architecture/frontend.md` (Perf harness bullet, ~line 471) and `docs/architecture/backend.md` (short note where testing/tooling is described) — invoke the `architecture-docs` skill first

- [ ] **Step 1: AGENTS.md** — append to the Testing list:

```markdown
- Performance: `perf/check.sh` (picks backend and/or frontend from the diff against `main`). Run it before considering backend, DB, API or `web/` work verified. It gates on counts (queries, VM work, full scans, fetches, renders) and flags timings only when they clearly worsen. A **regression** means: read your own diff along the regressed path, find the cause, fix it, re-run — and only bring it to Arthur, with the table and what you found, if it survives. **Unstable** means the harness is flaky (fix the harness, not the code); **stale baseline** means `perf/check.sh <side> --rebaseline`. Commit any baseline file it rewrites (improvements) with the change. A branch's final review package includes the perf table.
```

- [ ] **Step 2: verify skill** — after invoking `superpowers:writing-skills`, add a `## Performance` section to `.claude/skills/verify/SKILL.md`: when to run (`perf/check.sh` after any server/web change, in the worktree), what each verdict means and the response to it (same three as AGENTS.md, in the skill's voice), that it uses port 8977 and its own fixture (so it never conflicts with the verify scratch server on 8975), and where results land (`perf/out/`). No numeric thresholds in the prose.

- [ ] **Step 3: README and architecture docs**

In `web/tooling/perf/README.md`, add a short "Gate vs investigation" section at the top: `check.mjs` is the gate (run via `perf/check.sh`, headless, counts); `perf.mjs` and `ws-probe.mjs` stay the investigation tools; `baselines/<date>/` here is investigation history, not the gate's baseline (that lives in `perf/`). Mention `harness.mjs`. In `docs/architecture/frontend.md` update the Perf harness bullet to say part of it is now a gate, pointing at `perf/check.sh`; add one line to `backend.md` naming `server/tooling/perfcheck` and the fixture cache. Follow the architecture-docs skill (prefer a link or table over prose).

- [ ] **Step 4: Verify docs read right; commit**

Run: `grep -rn "load-bearing" AGENTS.md .claude/skills/verify docs/architecture web/tooling/perf/README.md` → no hits.

```bash
git add AGENTS.md .claude/skills/verify/SKILL.md web/tooling/perf/README.md docs/architecture
git commit -m "docs(<id>): wire perf/check.sh into AGENTS.md, /verify, perf README, architecture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Close out**

Run the full suites once more (`cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`; `cd web && pnpm verify`), then `perf/check.sh` (both sides changed on this branch — both must pass against the baselines recorded in Task 8). Mark the bean completed and commit the bean file. Hand off to `superpowers:finishing-a-development-branch`.
