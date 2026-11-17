# pattern: Imperative Shell
"""`pkm-mcp`: MCP stdio server exposing the PKM to MCP clients (Claude
Desktop, claude.ai). It registers `pkm.mcp.tools` on an `MCPServer`; the
tools themselves, and their LLM-facing docstrings, live there."""
from __future__ import annotations

import argparse
import functools
import inspect
from collections.abc import Callable, Sequence

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from pkm.mcp.names import READ_TOOL_NAMES
from pkm.mcp.tools import (DEFAULT_MAX_CHARS, MAX_RESULT_CHARS, TOOLS,
                           require_expect, set_max_chars)

_RESULT_META = {"anthropic/maxResultSizeChars": MAX_RESULT_CHARS}


def _reported(fn: Callable[..., str]) -> Callable[..., str]:
    """`fn`, with anything it raises re-raised as a `ToolError` carrying
    the same text. MCPServer shows the model only `Error executing tool
    <name>` for any other exception, and the tools' refusals and the
    server's rejections are messages the model and the approval panel
    read. `functools.wraps` keeps the signature MCPServer builds the
    argument model from. The wrapper is synchronous, so an `async def`
    tool is refused here rather than registered to return a coroutine."""
    if inspect.iscoroutinefunction(fn):
        raise TypeError(f"{fn.__name__}: _reported wraps sync tools only")

    @functools.wraps(fn)
    def tool(*args: object, **kwargs: object) -> str:
        try:
            return fn(*args, **kwargs)
        except ToolError:
            raise
        except Exception as exc:
            raise ToolError(str(exc)) from exc
    return tool


def build_server(names: Sequence[str] | None = None) -> MCPServer:
    """A server registering the `TOOLS` named in `names`, or all of them.
    A server built from a subset never has the rest: an unregistered tool
    cannot be called, whatever a client's permission gate decides."""
    known = {fn.__name__ for fn in TOOLS}
    unknown = sorted(set(names or ()) - known)
    if unknown:
        raise ValueError(
            f"unknown MCP tool(s): {', '.join(map(repr, unknown))}")
    server = MCPServer("pkm")
    for fn in TOOLS:
        if names is None or fn.__name__ in names:
            # Plain text, not MCPServer's default `{"result": ...}`: Claude
            # Code measures and hands on that JSON, whose escaping makes it
            # longer than the budget pkm-mcp held the text to.
            bounded = fn.__name__ in READ_TOOL_NAMES
            server.tool(structured_output=False if bounded else None,
                        meta=_RESULT_META if bounded else None)(
                            _reported(fn))
    return server


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="pkm-mcp")
    parser.add_argument(
        "--tools", help="comma-separated tool names to offer (default: all)")
    parser.add_argument(
        "--require-expect", action="store_true",
        help="refuse update_block and batch without expect (the PKM "
             "assistant's approval card sets it)")
    parser.add_argument(
        "--max-chars", type=int, default=DEFAULT_MAX_CHARS,
        help="size past which get_page/get_block return an outline and "
             f"the list tools a partial list (default: {DEFAULT_MAX_CHARS})")
    args = parser.parse_args(argv)
    if not 0 < args.max_chars <= MAX_RESULT_CHARS:
        parser.error(
            f"--max-chars must be between 1 and {MAX_RESULT_CHARS}")
    set_max_chars(args.max_chars)
    names = args.tools.split(",") if args.tools is not None else None
    if args.require_expect:
        require_expect()
    build_server(names).run()  # stdio transport


if __name__ == "__main__":
    main()
