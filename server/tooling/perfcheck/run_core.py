# pattern: Functional Core
"""Decisions for the perf orchestrator: which sides a diff touches, which
scenarios to re-run, the exit code, what to do next, and which cache entries
to prune."""
from __future__ import annotations

import re
from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass

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
    """One "what next" line per verdict present that has advice, in a fixed
    order."""
    present = set(verdicts)
    return [line.format(side=side) for verdict, line in _NEXT.items() if verdict in present]


def busy_reason(load1: float, cpus: int) -> str | None:
    """Why `load1` (the 1-min load average) on `cpus` cores is too busy to
    measure timings, or None when the machine is quiet enough."""
    limit = cpus * BUSY_LOAD_PER_CPU
    if load1 <= limit:
        return None
    return f"1-min load {load1:.1f} on {cpus} cores (limit {limit:.1f})"


# A load refusal lists this many of the busiest processes.
BUSY_TOP = 8
_COMMAND_WIDTH = 80
_PS_LINE = re.compile(r"\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*\S)")
# vitest workers title themselves `node (vitest N)`; pytest keeps its argv.
_TEST_RUNNER = re.compile(r"\b(?:vitest|pytest)\b")


@dataclass(frozen=True)
class Proc:
    pid: int
    ppid: int
    cpu: float
    command: str


def parse_ps(text: str) -> list[Proc]:
    """Rows of `ps -Ao pid=,ppid=,pcpu=,command=`; lines that are not one
    are skipped. macOS pads a process's changed title (vitest workers retitle
    themselves) with trailing spaces."""
    procs = []
    for line in text.splitlines():
        m = _PS_LINE.fullmatch(line.rstrip())
        if m:
            procs.append(Proc(int(m[1]), int(m[2]), float(m[3]), m[4]))
    return procs


def top_processes(procs: Iterable[Proc], n: int = BUSY_TOP) -> list[Proc]:
    return sorted(procs, key=lambda p: p.cpu, reverse=True)[:n]


def is_test_runner(command: str) -> bool:
    return _TEST_RUNNER.search(command) is not None


def _short_command(command: str) -> str:
    """`command` with each absolute path cut to its basename, so a long
    checkout path does not hide the script a `node` or `python` runs."""
    short = " ".join(w.rsplit("/", 1)[-1] if w.startswith("/") else w
                     for w in command.split(" "))
    if len(short) <= _COMMAND_WIDTH:
        return short
    return short[:_COMMAND_WIDTH - 1] + "…"


def busy_report(procs: Iterable[Proc], cwds: Mapping[int, str | None],
                checkout: str) -> list[str]:
    """Lines naming `procs` (the busiest, from `top_processes`), with the
    test runners whose cwd (from `cwds`) is under `checkout` flagged: a stale
    run of your own otherwise reads, from the load alone, as someone else's.
    Only an orphan (parent gone) is surely stale; a runner with a live parent
    may be another session's suite."""
    lines = ["top CPU processes:"]
    kinds = set()
    for p in procs:
        line = f"  {p.cpu:5.1f}%  pid {p.pid}  {_short_command(p.command)}"
        cwd = cwds.get(p.pid)
        if (is_test_runner(p.command) and cwd is not None
                and (cwd == checkout or cwd.startswith(checkout.rstrip("/") + "/"))):
            kind = "orphaned test runner" if p.ppid == 1 else "test runner"
            line += f"  <- {kind} in this checkout ({cwd})"
            kinds.add(kind)
        lines.append(line)
    if "orphaned test runner" in kinds:
        lines.append("an orphaned runner's parent is gone, so it is a stale run (an "
                     "abandoned or killed suite): stop it by pid and run the check again")
    if "test runner" in kinds:
        lines.append("a runner with a live parent may be another session's suite, or a "
                     "hung run of yours: check which before stopping it")
    return lines


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


_NO_MODULE = re.compile(r"ModuleNotFoundError: No module named '([\w.]+)'")
_NO_NAME = re.compile(r"ImportError: cannot import name '(\w+)' from '([\w.]+)'")


def _is_pkm(module: str) -> bool:
    return module == "pkm" or module.startswith("pkm.")


def missing_pkm_import(output: str) -> str | None:
    """The `pkm` import a failed subprocess's `output` says is missing: a
    module, or `name from module`. None for anything else, including a missing
    third-party module."""
    for m in _NO_MODULE.finditer(output):
        if _is_pkm(m.group(1)):
            return m.group(1)
    for m in _NO_NAME.finditer(output):
        if _is_pkm(m.group(2)):
            return f"{m.group(1)} from {m.group(2)}"
    return None


def missing_import_advice(name: str, merge_base: str, side: str) -> str:
    """Why a merge-base run died importing `name`, and the way out."""
    return (f"this branch's harness imports {name}, which merge base {merge_base} lacks; "
            "a merge-base run uses the branch's harness with the base's `pkm` package. "
            "Land that module on `main` first, so the merge base has it; or, if the "
            f"comparison with main is not needed, run `perf/check.sh {side} --bootstrap` "
            "and give the reason in the commit message")
