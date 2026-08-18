# pattern: Functional Core
"""What the harness subprocess is told: model alias and environment.

Provider routing is a pure decision over the requested model and whatever
credential the deployment has, so it lives here rather than mid-way through
`claude_engine.create_conversation`, which spawns things.
"""

from __future__ import annotations

from dataclasses import dataclass

from pkm.assistant.policy import ZAI_MODELS

# z.ai's Anthropic-compatible endpoint (GLM Coding Plan). It maps the Claude
# model aliases to its plan-default GLM server-side, so requesting "sonnet"
# through it always gets the plan's current GLM -- no version name to go stale.
ZAI_BASE_URL = "https://api.z.ai/api/anthropic"
ZAI_SDK_MODEL = "sonnet"


@dataclass(frozen=True)
class HarnessEnv:
    sdk_model: str
    """The alias handed to the SDK, which is not always the requested model."""
    env: dict[str, str]
    """The subprocess environment: tool loading, and provider overrides."""


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
