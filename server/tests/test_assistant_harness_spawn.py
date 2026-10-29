"""What the harness CLI and its pkm-mcp actually receive as environment.

A fake CLI stands in for Claude Code: it records its own environment, then
starts the pkm MCP server the way the real CLI does (the `--mcp-config`
command, with the config's `env` merged over the CLI's own) with the server
replaced by an environment dump, and exits so `create_conversation` fails
and cleans up.
"""

import asyncio
import json
import sys

import pytest
from claude_agent_sdk import ClaudeAgentOptions
from claude_agent_sdk._internal.transport import subprocess_cli
from claude_agent_sdk._internal.transport.subprocess_cli import (
    SubprocessCLITransport,
)
from fake_sdk_client import SECRET, _no_rows

from pkm.assistant.claude_engine import ClaudeEngine
from pkm.assistant.harness_env import (
    ZAI_BASE_URL,
    harness_env_names,
    resolve_harness_env,
)
from pkm.assistant.policy import SYSTEM_PROMPT

# The real client warns that allowed_tools approves the read tools without
# can_use_tool, which is the design: the callback gates writes.
pytestmark = pytest.mark.filterwarnings(
    "ignore::claude_agent_sdk.CanUseToolShadowedWarning")

PLANTED = {
    "OPENAI_API_KEY": "SYNTH-OPENAI", "GOODLINKS_API_KEY": "SYNTH-GL",
    "ZAI_API_KEY": "SYNTH-ZAI", "PKM_URL": "http://evil.invalid",
    "ANTHROPIC_BASE_URL": "http://evil.invalid", "HTTPS_PROXY": "http://p.invalid",
    "https_proxy": "http://p.invalid", "HTTP_PROXY": "http://p.invalid",
    "ALL_PROXY": "http://p.invalid", "NO_PROXY": "*",
}
# added inside every macOS process, and by Python's locale coercion
PROCESS_ADDED = {"__CF_USER_TEXT_ENCODING", "LC_CTYPE"}

FAKE_CLI = '''#!{python}
import json, os, subprocess, sys

if sys.argv[1:] == ["-v"]:
    print("2.1.301 (Claude Code)")
    sys.exit(0)
with open({cli_dump!r}, "w") as fh:
    json.dump(dict(os.environ), fh)
config = json.loads(sys.argv[sys.argv.index("--mcp-config") + 1])
cfg = config["mcpServers"]["pkm"]
argv = [cfg["command"], *cfg.get("args", [])]
at = next(i for i in range(len(argv) - 1)
          if argv[i:i + 2] == ["-m", "pkm.mcp.server"])
dump = ("import json, os; json.dump(dict(os.environ), open(%r, 'w'))"
        % {mcp_dump!r})
argv[at:] = ["-c", dump]
subprocess.run(argv, env={{**os.environ, **cfg.get("env", {{}})}}, check=True)
sys.exit(3)
'''


@pytest.fixture()
def spawned(tmp_path, monkeypatch):
    """Runs `create_conversation` against the fake CLI for one model."""
    fake = tmp_path / "fake-claude"
    fake.write_text(FAKE_CLI.format(
        python=sys.executable, cli_dump=str(tmp_path / "cli-env.json"),
        mcp_dump=str(tmp_path / "mcp-env.json")))
    fake.chmod(0o700)
    monkeypatch.setattr(SubprocessCLITransport, "_find_bundled_cli",
                        lambda self: str(fake))
    for name, value in PLANTED.items():
        monkeypatch.setenv(name, value)

    def spawn(model: str) -> None:
        engine = ClaudeEngine(
            base_url="http://127.0.0.1:8999", session_secret_hex=SECRET,
            config_dir=tmp_path, zai_token="zk-test", read_blocks=_no_rows)
        with pytest.raises(Exception):
            asyncio.run(engine.create_conversation(SYSTEM_PROMPT, model))
        assert list(tmp_path.glob("pkm-assistant-*")) == []

    return spawn


@pytest.mark.parametrize("model", ["sonnet", "glm"])
def test_the_harness_cli_gets_only_the_allowed_environment(
        model, spawned, tmp_path):
    spawned(model)
    cli_env = json.loads((tmp_path / "cli-env.json").read_text())
    for name, value in PLANTED.items():
        assert cli_env.get(name) != value, name
    assert {"PATH", "HOME", "ENABLE_TOOL_SEARCH",
            "CLAUDE_CODE_ENTRYPOINT"} <= set(cli_env)
    if model == "glm":
        assert cli_env["ANTHROPIC_BASE_URL"] == ZAI_BASE_URL
        assert cli_env["ANTHROPIC_AUTH_TOKEN"] == "zk-test"
    else:
        assert "ANTHROPIC_BASE_URL" not in cli_env


@pytest.mark.parametrize("model", ["sonnet", "glm"])
def test_pkm_mcp_gets_only_its_config_path(model, spawned, tmp_path):
    spawned(model)
    mcp_env = json.loads((tmp_path / "mcp-env.json").read_text())
    assert set(mcp_env) - PROCESS_ADDED == {"PKM_CLI_CONFIG"}


class _Spawned(Exception):
    pass


def test_every_variable_the_sdk_sets_is_kept(monkeypatch):
    harness = resolve_harness_env("glm", "zk")
    monkeypatch.setattr(subprocess_cli.os, "environ",
                        {"CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK": "1"})
    recorded: dict[str, str] = {}

    async def open_process(*args, env, **kwargs):
        recorded.update(env)
        raise _Spawned

    monkeypatch.setattr(subprocess_cli.anyio, "open_process", open_process)
    transport = SubprocessCLITransport(prompt="", options=ClaudeAgentOptions(
        env=harness.env, cli_path="/x"))
    with pytest.raises(Exception) as raised:
        asyncio.run(transport.connect())
    assert isinstance(raised.value.__cause__, _Spawned)
    added = set(recorded) - {"CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK"}
    assert added - set(harness_env_names(harness)) == set()
