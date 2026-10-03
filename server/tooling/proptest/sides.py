# pattern: Functional Core
"""Decisions for the proptest orchestrator: which sides a diff touches,
and which of those sides has a property suite to run yet."""
from __future__ import annotations

from collections.abc import Iterable

# Same rule as perfcheck.run_core._SIDES: e2e specs and docs under web/
# don't change what the browser runs.
# The web suite drives the real server's sync routes, so server/src and the
# harness launcher count as web changes too.
_SIDES = (("server", lambda p: p.startswith("server/")),
          ("web", lambda p: (p.startswith("web/") and not p.startswith("web/e2e/")
                             and not p.endswith(".md"))
           or p.startswith("server/src/")
           or p == "server/tooling/proptest/sync_server.py"))

_AVAILABLE = {"server", "web"}


def sides_for(paths: Iterable[str]) -> list[str]:
    paths = list(paths)
    return [side for side, touches in _SIDES if any(touches(p) for p in paths)]


def available(side: str) -> bool:
    return side in _AVAILABLE
