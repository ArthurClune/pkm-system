# pattern: Imperative Shell
"""Run a PKM MCP tool as the `pkm-mcp` subprocess runs it, with the input
the Agent SDK would hand that subprocess after an Allow.

`run_tool` goes through FastMCP's own argument path (its JSON pre-parse,
then the argument model built from the tool's signature) without building
a `FastMCP`: constructing one reconfigures the root logger, which the e2e
server has already handed to uvicorn."""
from __future__ import annotations

import asyncio
from collections.abc import Mapping

from claude_agent_sdk import PermissionResultAllow
from mcp.server.fastmcp.utilities.func_metadata import func_metadata

import pkm.mcp.tools


def run_tool(short: str, tool_input: Mapping[str, object]) -> str:
    """The text tool `short` returns for `tool_input`. Its errors raise,
    as they would inside the subprocess before FastMCP reports them."""
    fn = getattr(pkm.mcp.tools, short)
    result = asyncio.run(func_metadata(fn).call_fn_with_arg_validation(
        fn, False, dict(tool_input), None))
    return str(result)


def sdk_tool_input(original: Mapping[str, object],
                   decision: PermissionResultAllow) -> dict[str, object]:
    """The input the SDK sends the CLI for an allowed call: the decision's
    `updated_input` when it set one, else the model's own input."""
    if decision.updated_input is not None:
        return dict(decision.updated_input)
    return dict(original)
