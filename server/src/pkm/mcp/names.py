"""Names of the tools `pkm-mcp` serves read-only: those whose output it
bounds, and those the in-app assistant may call without an approval card."""

READ_TOOL_NAMES: tuple[str, ...] = (
    "get_page", "get_block", "search", "query", "backlinks", "todos",
    "changed_blocks", "search_assets")
