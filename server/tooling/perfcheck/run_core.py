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
