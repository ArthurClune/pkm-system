import json
import subprocess
import sys
from pathlib import Path

import pytest

from pkm.assistant import harness_env
from pkm.assistant.harness_env import (
    HOST_ENV,
    SDK_ENV,
    ZAI_BASE_URL,
    harness_env_names,
    launcher_script,
    mcp_server_config,
    resolve_harness_env,
)
from pkm.assistant.policy import MODELS, ZAI_MODELS


def test_claude_models_get_the_tool_loading_env_and_nothing_else():
    resolved = resolve_harness_env("opus", zai_token=None)
    assert resolved.sdk_model == "opus"
    assert resolved.env == {"ENABLE_TOOL_SEARCH": "false"}


def test_a_configured_zai_key_never_leaks_into_a_claude_run():
    resolved = resolve_harness_env("haiku", zai_token="zk-test")
    assert resolved.env == {"ENABLE_TOOL_SEARCH": "false"}


def test_fable_is_a_claude_model_on_the_subscription_not_zai():
    assert "fable" in MODELS
    assert "fable" not in ZAI_MODELS
    resolved = resolve_harness_env("fable", zai_token="zk-test")
    assert resolved.sdk_model == "fable"
    assert resolved.env == {"ENABLE_TOOL_SEARCH": "false"}
    assert "ANTHROPIC_BASE_URL" not in resolved.env


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


def test_harness_env_names_keeps_host_sdk_and_harness_names():
    names = harness_env_names(resolve_harness_env("glm", "zk"))
    assert names[:len(HOST_ENV + SDK_ENV)] == HOST_ENV + SDK_ENV
    assert {"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
            "ENABLE_TOOL_SEARCH"} <= set(names)
    assert len(names) == len(set(names))
    sonnet = harness_env_names(resolve_harness_env("sonnet", None))
    assert "ANTHROPIC_BASE_URL" not in sonnet


def test_no_secret_or_routing_name_is_kept():
    refused = {"OPENAI_API_KEY", "GOODLINKS_API_KEY", "ZAI_API_KEY",
               "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "PKM_URL",
               "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
               "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"}
    refused |= {name.lower() for name in refused}
    for model in MODELS:
        names = harness_env_names(resolve_harness_env(model, "zk"))
        assert refused.isdisjoint(names), model


def _launcher(tmp_path: Path, names: list[str],
              cli_name: str = "dumper") -> tuple[Path, Path]:
    """A launcher for a CLI that dumps its environment to `env.json`."""
    dump = tmp_path / "env.json"
    cli = tmp_path / cli_name
    cli.write_text(f"#!{sys.executable}\n"
                   "import json, os\n"
                   f"json.dump(dict(os.environ), open({str(dump)!r}, 'w'))\n")
    cli.chmod(0o700)
    launcher = tmp_path / "launcher.sh"
    launcher.write_text(launcher_script(str(cli), names))
    launcher.chmod(0o700)
    return launcher, dump


def test_launcher_passes_kept_values_byte_identical(tmp_path):
    launcher, dump = _launcher(tmp_path, ["HOME", "ODD"])
    odd = "x \"y\" $z '\n' w"
    subprocess.run([launcher], check=True,
                   env={"HOME": "/Users/a b", "ODD": odd, "SECRET": "s"})
    env = json.loads(dump.read_text())
    assert env["HOME"] == "/Users/a b"
    assert env["ODD"] == odd
    assert "SECRET" not in env


def test_launcher_leaves_a_missing_name_unset(tmp_path):
    launcher, dump = _launcher(tmp_path, ["HOME", "ODD"])
    subprocess.run([launcher], check=True, env={"ODD": "1"})
    assert "HOME" not in json.loads(dump.read_text())


def test_launcher_quotes_the_cli_path(tmp_path):
    launcher, dump = _launcher(tmp_path, ["HOME"], cli_name="it's a cli")
    subprocess.run([launcher], check=True, env={"HOME": "/h"})
    assert json.loads(dump.read_text())["HOME"] == "/h"


def test_launcher_refuses_a_name_the_shell_would_interpret():
    with pytest.raises(ValueError):
        launcher_script("/x", ["A;rm"])


def test_launcher_refuses_a_cli_path_env_would_parse_as_an_assignment():
    with pytest.raises(ValueError):
        launcher_script("/a=b/claude", ["HOME"])


def test_mcp_server_config_runs_pkm_mcp_under_an_empty_environment():
    assert mcp_server_config(
        "/py", "/c.json", ["--tools", "a,b", "--require-expect"]) == {
        "type": "stdio", "command": "/usr/bin/env",
        "args": ["-i", "PKM_CLI_CONFIG=/c.json", "/py", "-m",
                 "pkm.mcp.server", "--tools", "a,b", "--require-expect"]}


def test_mcp_server_config_refuses_an_interpreter_env_would_parse_as_an_assignment():
    with pytest.raises(ValueError):
        mcp_server_config("/a=b/python", "/c.json", [])
