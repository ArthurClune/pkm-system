"""An asyncio loop on a virtual clock that jumps to the next timer whenever
nothing is ready, so a property can wait out a 300 s stall watchdog or a
5 s interrupt bound in microseconds, and replay the same interleaving from
its seed. Only for code that does no real I/O: a thread or socket the loop
waits on would be skipped past, not waited for."""
from __future__ import annotations

import asyncio
import selectors


class _JumpSelector(selectors.DefaultSelector):
    def __init__(self) -> None:
        super().__init__()
        self.clock: VirtualTimeLoop | None = None

    def select(self, timeout: float | None = None):
        ready = super().select(0)
        if ready or timeout == 0:
            return ready
        if timeout is None:
            raise RuntimeError("virtual loop deadlock: nothing is ready and "
                               "no timer is pending")
        assert self.clock is not None
        self.clock.now += timeout
        return []


class VirtualTimeLoop(asyncio.SelectorEventLoop):
    def __init__(self) -> None:
        selector = _JumpSelector()
        super().__init__(selector)
        selector.clock = self
        self.now = 0.0

    def time(self) -> float:
        return self.now
