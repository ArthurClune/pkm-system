# pattern: Imperative Shell
"""`pkm-mcp`: MCP stdio server exposing the PKM to MCP clients (Claude
Desktop, claude.ai). It registers `pkm.mcp.tools` on a `FastMCP`; the
tools themselves, and their LLM-facing docstrings, live there."""
from __future__ import annotations

import argparse
from collections.abc import Sequence

from mcp.server.fastmcp import FastMCP

from pkm.mcp.tools import (DEFAULT_MAX_CHARS, MAX_RESULT_CHARS, TOOLS,
                           get_block, get_page, require_expect,
                           set_max_chars)

_RESULT_META = {"anthropic/maxResultSizeChars": MAX_RESULT_CHARS}


def build_server(names: Sequence[str] | None = None) -> FastMCP:
    """A server registering the `TOOLS` named in `names`, or all of them.
    A server built from a subset never has the rest: an unregistered tool
    cannot be called, whatever a client's permission gate decides."""
    known = {fn.__name__ for fn in TOOLS}
    unknown = sorted(set(names or ()) - known)
    if unknown:
        raise ValueError(
            f"unknown MCP tool(s): {', '.join(map(repr, unknown))}")
    server = FastMCP("pkm")
    for fn in TOOLS:
        if names is None or fn.__name__ in names:
            # Plain text, not FastMCP's default `{"result": ...}`: Claude
            # Code measures and hands on that JSON, whose escaping makes it
            # longer than the budget pkm-mcp held the text to.
            bounded = fn in (get_page, get_block)
            server.tool(structured_output=False if bounded else None,
                        meta=_RESULT_META if bounded else None)(fn)
    return server


mcp = build_server()


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
        help="size past which get_page and get_block return an outline "
             f"(default: {DEFAULT_MAX_CHARS})")
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
