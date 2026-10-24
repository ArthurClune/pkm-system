# pattern: Imperative Shell
"""`pkm-mcp`: MCP stdio server exposing the PKM to MCP clients (Claude
Desktop, claude.ai). It registers `pkm.mcp.tools` on a `FastMCP`; the
tools themselves, and their LLM-facing docstrings, live there."""
from __future__ import annotations

import argparse
from collections.abc import Sequence

from mcp.server.fastmcp import FastMCP

from pkm.mcp.tools import TOOLS


def build_server(names: Sequence[str] | None = None) -> FastMCP:
    """A server registering the `TOOLS` named in `names`, or all of them.
    A server built from a subset never has the rest: an unregistered tool
    cannot be called, whatever a client's permission gate decides."""
    known = {fn.__name__ for fn in TOOLS}
    unknown = sorted(set(names or ()) - known)
    if unknown:
        raise ValueError(f"unknown MCP tool(s): {', '.join(unknown)}")
    server = FastMCP("pkm")
    for fn in TOOLS:
        if names is None or fn.__name__ in names:
            server.tool()(fn)
    return server


mcp = build_server()


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="pkm-mcp")
    parser.add_argument(
        "--tools", help="comma-separated tool names to offer (default: all)")
    args = parser.parse_args(argv)
    names = args.tools.split(",") if args.tools is not None else None
    build_server(names).run()  # stdio transport


if __name__ == "__main__":
    main()
