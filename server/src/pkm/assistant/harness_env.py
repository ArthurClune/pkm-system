# pattern: Functional Core
"""What the harness subprocess is told: model alias and environment.

Provider routing is a pure decision over the requested model and whatever
credential the deployment has, so it lives here rather than mid-way through
`claude_engine.create_conversation`, which spawns things.

Neither the harness CLI nor its pkm-mcp inherits the server's environment,
which holds other services' keys and proxy routing. The CLI is started
through `launcher_script`, which passes on only the names
`harness_env_names` lists; pkm-mcp is started by `mcp_server_config` with
nothing but its credential file's path.
"""

from __future__ import annotations

import re
import shlex
from collections.abc import Sequence
from dataclasses import dataclass

from claude_agent_sdk.types import McpStdioServerConfig

from pkm.assistant.policy import ZAI_MODELS

# z.ai's Anthropic-compatible endpoint (GLM Coding Plan). It maps the Claude
# model aliases to its plan-default GLM server-side, so requesting "sonnet"
# through it always gets the plan's current GLM -- no version name to go stale.
ZAI_BASE_URL = "https://api.z.ai/api/anthropic"
ZAI_SDK_MODEL = "sonnet"

# The CLI reads its subscription login from the macOS Keychain by running
# `security`, found on PATH, for the account named by USER; the two
# CLAUDE_*_DIR variables pick which Keychain service holds it.
HOST_ENV: tuple[str, ...] = (
    "PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
    "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
)
# The SDK sets these itself in `SubprocessCLITransport.connect`;
# test_assistant_harness_spawn.py fails naming any other it starts setting.
SDK_ENV: tuple[str, ...] = (
    "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_SDK_READS_SESSION_STATE",
)
ENV_BIN = "/usr/bin/env"

_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


@dataclass(frozen=True)
class HarnessEnv:
    sdk_model: str
    """The alias handed to the SDK, which is not always the requested model."""
    env: dict[str, str]
    """Tool loading and provider overrides: with `HOST_ENV` and `SDK_ENV`,
    the harness subprocess's whole environment, not additions to the
    server's."""


def resolve_harness_env(model: str, zai_token: str | None) -> HarnessEnv:
    """Resolve `model` to an SDK alias plus the env the harness needs.

    Raises ValueError for a z.ai-routed model with no key, which the routes
    surface as a 400. Callers are expected to resolve *before* writing the
    credential file or spawning anything, so a rejected model leaves nothing
    behind; the models endpoint hides these models in that state anyway, so
    only a hand-crafted request reaches the error.
    """
    # the CLI defers MCP tools behind ToolSearch by default, which tools=[]
    # would make unreachable -- disabling tool search loads the pkm tools
    # eagerly; verified live 2026-07-27
    env = {"ENABLE_TOOL_SEARCH": "false"}
    # Keyed on ZAI_MODELS membership, never on a "glm" literal: a second
    # z.ai-hosted model added to policy must not silently run on the Claude
    # subscription instead.
    if model not in ZAI_MODELS:
        return HarnessEnv(sdk_model=model, env=env)
    if not zai_token:
        raise ValueError(f"model {model!r} requires a z.ai key (zai_api_key_file)")
    env["ANTHROPIC_BASE_URL"] = ZAI_BASE_URL
    env["ANTHROPIC_AUTH_TOKEN"] = zai_token
    return HarnessEnv(sdk_model=ZAI_SDK_MODEL, env=env)


def harness_env_names(harness: HarnessEnv) -> tuple[str, ...]:
    """The names the harness CLI may receive, in launcher order."""
    return tuple(dict.fromkeys((*HOST_ENV, *SDK_ENV, *sorted(harness.env))))


def launcher_script(cli: str, names: Sequence[str]) -> str:
    """A shell script that runs `cli` with only `names` from its own
    environment.

    Each name becomes one `${NAME+"NAME=$NAME"}` word: an unset name adds
    nothing, and a set one reaches `env` as a single argument whatever its
    value holds. `exec` keeps the pid the SDK signals the CLI's own.
    """
    for name in names:
        if not _ENV_NAME.fullmatch(name):
            raise ValueError(f"not an environment variable name: {name!r}")
    kept = "".join(f' ${{{name}+"{name}=${name}"}}' for name in names)
    return f'#!/bin/sh\nexec {ENV_BIN} -i{kept} {shlex.quote(cli)} "$@"\n'


def mcp_server_config(python: str, config_path: str,
                      server_args: Sequence[str]) -> McpStdioServerConfig:
    """The `pkm` MCP server entry: pkm-mcp under `env -i`, so it sees its
    credential file's path and none of the CLI's environment."""
    if "=" in python:
        # env would take the interpreter for another variable assignment
        raise ValueError(f"interpreter path contains '=': {python!r}")
    return {
        "type": "stdio",
        "command": ENV_BIN,
        "args": ["-i", f"PKM_CLI_CONFIG={config_path}", python,
                 "-m", "pkm.mcp.server", *server_args],
    }
