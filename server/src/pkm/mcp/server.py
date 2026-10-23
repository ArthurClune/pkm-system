# pattern: Imperative Shell
"""`pkm-mcp`: MCP stdio server exposing the PKM to MCP clients (Claude
Desktop, claude.ai). It registers `pkm.mcp.tools` on a `FastMCP`; the
tools themselves, and their LLM-facing docstrings, live there."""
from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from pkm.mcp.tools import TOOLS

mcp = FastMCP("pkm")

for _fn in TOOLS:
    mcp.tool()(_fn)


def main() -> None:
    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()
