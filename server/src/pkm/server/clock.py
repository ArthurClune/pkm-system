# pattern: Imperative Shell
"""The wall clock routes read, as a dependency."""
from __future__ import annotations

import time


def now_ms() -> int:
    """Epoch milliseconds. A route dependency, so a test fixes the time
    through `app.dependency_overrides[now_ms]`."""
    return int(time.time() * 1000)
