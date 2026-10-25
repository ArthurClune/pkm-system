"""Work counts for scaling tests: how much a call loops, measured in a way
that a busy machine does not move."""
import sys
from collections.abc import Callable, Iterable
from types import ModuleType


def loop_steps(module: ModuleType | Iterable[ModuleType],
               run: Callable[[], object]) -> int:
    """Loop iterations (jumps) in `module`'s file during `run()`, or in
    any of their files when given several: work a module hands to a helper
    module is otherwise not seen.

    A count of the work done that, unlike a timing, does not move on a
    busy machine, and that sees a generator expression's iterations,
    which raise no line events. Work done in C (a regex, str.find) is
    not counted. sys.monitoring rather than sys.settrace, so coverage's
    tracer stays in place."""
    mon = sys.monitoring
    tool = next(i for i in range(6) if mon.get_tool(i) is None)
    count = 0
    modules = [module] if isinstance(module, ModuleType) else list(module)
    filenames = {m.__file__ for m in modules}

    def on_jump(code, offset, target):
        nonlocal count
        if code.co_filename in filenames:
            count += 1

    mon.use_tool_id(tool, "scaling-test")
    mon.register_callback(tool, mon.events.JUMP, on_jump)
    mon.set_events(tool, mon.events.JUMP)
    try:
        run()
    finally:
        mon.set_events(tool, 0)
        mon.register_callback(tool, mon.events.JUMP, None)
        mon.free_tool_id(tool)
    return count
