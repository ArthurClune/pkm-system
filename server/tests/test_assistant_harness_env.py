import pytest

from pkm.assistant import harness_env
from pkm.assistant.harness_env import ZAI_BASE_URL, resolve_harness_env
from pkm.assistant.policy import MODELS, ZAI_MODELS


def test_claude_models_get_the_tool_loading_env_and_nothing_else():
    resolved = resolve_harness_env("opus", zai_token=None)
    assert resolved.sdk_model == "opus"
    assert resolved.env == {"ENABLE_TOOL_SEARCH": "false"}


def test_a_configured_zai_key_never_leaks_into_a_claude_run():
    resolved = resolve_harness_env("haiku", zai_token="zk-test")
    assert resolved.env == {"ENABLE_TOOL_SEARCH": "false"}


def test_zai_models_route_to_zai_under_the_sonnet_alias():
    resolved = resolve_harness_env("glm", zai_token="zk-test")
    # z.ai maps the Claude alias to its plan-default GLM server-side, so no
    # GLM version name is hardcoded anywhere
    assert resolved.sdk_model == "sonnet"
    assert resolved.env["ANTHROPIC_BASE_URL"] == ZAI_BASE_URL
    assert resolved.env["ANTHROPIC_AUTH_TOKEN"] == "zk-test"
    # the MCP-tool eager-load setting must survive the provider override
    assert resolved.env["ENABLE_TOOL_SEARCH"] == "false"


def test_routing_is_keyed_on_the_model_set_not_a_glm_literal(monkeypatch):
    monkeypatch.setattr(harness_env, "ZAI_MODELS", ("glm", "glm-air"))
    assert resolve_harness_env("glm-air", zai_token="zk-test").sdk_model == "sonnet"


@pytest.mark.parametrize("token", [None, ""])
def test_a_zai_model_without_a_key_is_refused(token):
    with pytest.raises(ValueError, match="z.ai"):
        resolve_harness_env("glm", zai_token=token)


def test_every_advertised_model_resolves_when_its_provider_is_configured():
    # a new entry in policy.MODELS must not be resolvable only by accident
    for model in MODELS:
        resolved = resolve_harness_env(model, zai_token="zk-test")
        assert resolved.sdk_model
        expected = "ANTHROPIC_BASE_URL" in resolved.env
        assert expected is (model in ZAI_MODELS)
