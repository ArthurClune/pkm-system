# pattern: Functional Core
"""Decisions for the perf orchestrator: which sides a diff touches, which
scenarios to re-run, the exit code, what to do next, and which cache entries
to prune."""
from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping

from perfcheck.compare import TIMING_FACTOR, Comparison, Outcome

# e2e specs and docs under web/ don't change what the browser runs
_SIDES = (("backend", lambda p: p.startswith("server/")),
          ("frontend", lambda p: p.startswith("web/") and not p.startswith("web/e2e/")
           and not p.endswith(".md")))

# check.mjs runs these letters in one shared browser context each; counts
# were recorded in that company, so a re-run takes the whole group
_CONTEXT_GROUPS = ("HW", "ABFI", "JKS", "R")

# 1-min load per core above which a machine counts as busy. On the 10-core
# dev Mac an idle check's own load sits around 2-2.5 (0.25 per core), while a
# parallel test suite or CPU burners push it past 10 (1.0 per core).
BUSY_LOAD_PER_CPU = 0.5

_NEXT = {
    "regression": "regression: read your diff along the regressed path, find the cause, "
                  "fix it and re-run; bring it to Arthur only if it survives",
    "unstable": "unstable: the harness is flaky, not your change; file a bean against the "
                "perf harness and carry on",
    "stale-baseline": "stale-baseline: re-record at the merge base with "
                      "`perf/check.sh {side} --rebaseline`, then check again",
    "lost": "lost: coverage changed; re-record with `perf/check.sh {side} --bootstrap` "
            "and give the reason in the commit message",
    "reclassified": "reclassified: a metric changed class; re-record with "
                    "`perf/check.sh {side} --bootstrap` and give the reason in the commit message",
    "faster": f"faster: a timing beat its baseline by more than {TIMING_FACTOR:g}x, which machine "
              "load can also cause; one run never lowers a timing baseline — if the gain is "
              "real, record it with `perf/check.sh {side} --bootstrap` on a quiet machine",
}


def sides_for(paths: Iterable[str]) -> list[str]:
    paths = list(paths)
    return [side for side, touches in _SIDES if any(touches(p) for p in paths)]


def scenarios_of(findings: Iterable) -> list[str]:
    return sorted({f.scenario for f in findings})


def frontend_letters(names: Iterable[str]) -> str:
    letters = {n.split("/", 1)[0] for n in names}
    known = {x for g in _CONTEXT_GROUPS for x in g}
    unknown = letters - known
    if unknown:
        raise ValueError(f"scenario letter(s) {sorted(unknown)} are not in any _CONTEXT_GROUPS "
                         f"group {_CONTEXT_GROUPS}; add the group before re-running")
    return ",".join(sorted({x for g in _CONTEXT_GROUPS if letters & set(g) for x in g}))


def next_steps(side: str, verdicts: Iterable[str]) -> list[str]:
    """One "what next" line per verdict present that has advice, in a fixed order."""
    present = set(verdicts)
    return [line.format(side=side) for verdict, line in _NEXT.items() if verdict in present]


def busy_reason(load1: float, cpus: int) -> str | None:
    """Why `load1` (the 1-min load average) on `cpus` cores is too busy to
    measure timings, or None when the machine is quiet enough."""
    limit = cpus * BUSY_LOAD_PER_CPU
    if load1 <= limit:
        return None
    return f"1-min load {load1:.1f} on {cpus} cores (limit {limit:.1f})"


def incomparable_advice(reason: str) -> str:
    """Which command fixes an incomparable-baseline `reason` (from
    `perfcheck.compare.incomparable_reason`): "rebaseline" or "bootstrap".

    A merge-base run still uses this branch's harness, so `fixture_hash` and
    `chromium` come from the branch either way — `--rebaseline` catches them
    up. `python` and `sqlite` come from the merge-base worktree's own venv,
    so `--rebaseline` would reproduce the old environment and refuse again;
    the fix is to read the diff, then `--bootstrap` on the branch."""
    return "bootstrap" if "python" in reason or "sqlite" in reason else "rebaseline"


def stale_entries(last_used: Mapping[str, float], now: float, keep: Collection[str],
                  max_age_s: float) -> list[str]:
    """Cache entries unused for longer than `max_age_s`, never one in `keep`."""
    return sorted(name for name, used in last_used.items()
                  if name not in keep and now - used > max_age_s)


def exit_code(c: Comparison, outcomes: Mapping[tuple[str, str], Outcome]) -> int:
    return 1 if c.blocking or outcomes else 0
