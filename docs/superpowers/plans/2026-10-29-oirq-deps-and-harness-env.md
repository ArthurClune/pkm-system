# Dependency upgrades and minimal harness environment (pkm-oirq) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant's harness subprocess and its `pkm-mcp` start with an
explicit allow-listed environment, `pkm-mcp` takes its URL only from the
config file it is handed, and the Python and web dependencies carry no
advisory that has a fix on the current major.

**Architecture:** The Claude Agent SDK always builds the CLI's environment as
`{**os.environ, **options.env}` (`subprocess_cli.py`, `connect`), so options
alone cannot remove a variable. The engine therefore points
`ClaudeAgentOptions.cli_path` at a per-conversation launcher script that
`exec`s `/usr/bin/env -i` with only the allow-listed names and then the real
CLI. `pkm-mcp` is configured as `/usr/bin/env -i PKM_CLI_CONFIG=<path>
<python> -m pkm.mcp.server ...`, so it gets nothing from the CLI's
environment. The name lists and the script text are pure functions in
`harness_env.py` (Functional Core); `claude_engine.py` writes the file and
wires it in.

**Tech Stack:** Python 3.12, claude-agent-sdk 0.2.168 (bundled CLI 2.1.301),
mcp, uv; web: pnpm 12, mermaid, dompurify, katex, react-router-dom.

**Spec:** the bean, `beans show pkm-oirq`; the review finding is F5 in
`docs/security-review-2026-10-23.md` (the probes it names are gitignored and
will be deleted; everything the tests need is restated here).

## Global Constraints

- Work only in the worktree `/Users/arthur/code/llm/pkm/.claude/worktrees/oirq-deps` (branch `security/oirq-deps`). Never touch the main checkout.
- Port 8974 is production: never bind it. Use `E2E_PORT=8981` for any server or Playwright run.
- TDD: each behaviour's test is written and seen failing before the code.
- FCIS headers on every file with runtime behaviour; `harness_env.py` stays `# pattern: Functional Core` (no file, env or process access in it).
- Comment rules: no bean ids, line numbers or plan pointers in comments; comment lines at most 80 columns, code at most 120.
- No Python or SQLite version change. Python stays 3.12.10 and SQLite 3.47.1 (checked: worktree venv and prod's `~/.config/pkm/app/server/.venv/bin/python` both report these). SQLite must stay >= 3.43.
- uv's global cooldown (`exclude-newer = "5 days"`) and pnpm's `min-release-age=5` stay in force; every target version below resolved under them on 2026-10-29.
- `docs/SECURITY.md` is not edited on this branch (a later bean rewrites its rows).
- Stage files by explicit path only; never `.beans/`, `.superpowers/` or `web/node_modules`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and carry no session URL.

## Measured upgrade set (2026-10-29)

Python (`uvx pip-audit` 2.10.1 over `uv export --frozen --all-groups`):
31 advisories in 7 packages today. After the upgrades below a re-audit
reported **no known vulnerabilities** (measured on a throwaway lock, then
reverted).

| Package | Locked | Target | Why |
|---|---|---|---|
| pyjwt | 2.13.0 | 2.15.1 | 15 advisories, fixes in 2.14.0 and 2.15.0 (transitive via `mcp[crypto]`) |
| cryptography | 49.0.0 | 50.0.2 | PYSEC-2026-3552, fixed in 50.0.0 |
| mcp | 1.28.1 | 1.30.0 | 4 CVEs, fixed in 1.30.0 or 2.2.0 |
| anyio | 4.14.1 | 4.15.1 | 3 advisories, fixed in 4.14.2 |
| httpx2 | 2.5.0 | 2.16.0 | 4 advisories, the last fixed in 2.12.0 |
| httpcore2 | 2.5.0 | 2.16.0 | PYSEC-2026-3844, fixed in 2.10.0 |
| certifi | 2026.6.17 | 2026.10.23 | PYSEC-2026-4320 |

An unbounded `--upgrade-package mcp` resolves **mcp 2.3.0**, a new major
(it drops httpx, pydantic-settings and adds `mcp-types`). This branch holds
`mcp` below 2: the fix is in 1.30.0, and a major bump of the library
`pkm-mcp` is built on is its own piece of work. The httpx2 jump adds a new
dependency, `httpx2-jsfetch` 1.0.

Web (`pnpm audit --prod`): 15 advisories today (1 critical, 1 high).

| Package | Locked | Target | How |
|---|---|---|---|
| mermaid | 11.16.0 | 11.16.1 | direct, pinned `~11.16.1` (see Task 4) |
| dompurify | 3.4.11 | 3.4.17 | transitive via mermaid (`^3.3.3`); `pnpm update dompurify` |
| katex | 0.17.0 | 0.18.10 | direct `^0.18.10` **and** the `katex` override in `pnpm-workspace.yaml` (the override alone decides the installed version) |
| react-router-dom / react-router | 6.30.4 | 6.30.6 | direct `^6.30.6` |

After these, `pnpm audit --prod` reports exactly two moderate advisories,
both in `react-router >=6.0.0 <7.18.0`, fixed only in 7.18.0 (a major
upgrade): GHSA-wrjc-x8rr-h8h6 (open redirect via a backslash in `<Link>` /
`useNavigate`) and GHSA-337j-9hxr-rhxg (constructor injection in SSR
hydration's `deserializeErrors`). The app mounts `BrowserRouter` (no data
router, no SSR hydration data), and page links come from `paths.ts`
`pagePath`, which always starts `/page/` and percent-encodes every segment,
so a backslash never reaches a link target. Whether to migrate to v7 is an
open question for Arthur; this branch does not.

## Environment allow-list and its evidence

The harness CLI gets exactly these names, each only when the server's
environment (or `options.env`) has it:

| Name | Evidence it is needed |
|---|---|
| `PATH` | The bundled CLI 2.1.301 reads the Claude login with `execFile("security", ["find-generic-password", "-a", <account>, "-w", "-s", <service>])`, a bare command name resolved on `PATH` (`/usr/bin/security`). Prod's plist sets `PATH` |
| `HOME` | The CLI's config home (`~/.claude`, `~/.claude.json`) and caches come from the home directory: the review's probe ran it with a fake `HOME` and it wrote `fakehome/Library/Caches/claude-cli-nodejs/...`. `deploy/README.md` § Assistant prerequisites already requires `HOME` for the login |
| `USER` | The Keychain account is `process.env.USER \|\| os.userInfo().username` (the CLI's `$x()`); kept so the account looked up is the one used today |
| `TMPDIR` | macOS sets a per-user temp dir through launchd; without it Node's `os.tmpdir()` falls back to the shared `/tmp` |
| `LANG`, `LC_ALL`, `LC_CTYPE` | Locale only; the review's probe showed the CLI running with `LC_CTYPE`. No secret or route can be spelled in them |
| `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR` | Both choose the config directory and the Keychain service name: the CLI's `v1()` appends a hash of the directory to `Claude Code-credentials` when either is set. Dropping one that is set would look up a different login. Prod sets neither (its plist's `EnvironmentVariables` are only `PATH` and `VIRTUAL_ENV`) |
| `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_SDK_READS_SESSION_STATE` | Set by the SDK itself in `connect` (`"sdk-py"`, its version, and `"1"` so the CLI emits the session-state frames the SDK waits on) |
| every key of `HarnessEnv.env` | `ENABLE_TOOL_SEARCH` always; `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for z.ai models. `options.env` wins the SDK's merge, so these values are the engine's own |

Everything else is dropped, including `OPENAI_API_KEY`, `GOODLINKS_API_KEY`,
`ZAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `PKM_URL`,
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` in both cases,
`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and an inherited
`ANTHROPIC_BASE_URL` on a Claude-model conversation. `SHELL` is dropped: the
CLI looks up a shell only for its Bash tool (`tools=[]` disables it), and its
lookup falls back to probing `/bin/zsh`, `/bin/bash` and the like when
`SHELL` is unset.

`pkm-mcp` gets only `PKM_CLI_CONFIG`. It reads no other variable
(`client/api.py` `config_path` falls back to `Path.home()` only without
`PKM_CLI_CONFIG`), the `mcp` stdio server wraps stdin and stdout as UTF-8
itself, and the venv interpreter needs no `VIRTUAL_ENV`. Checked: `/usr/bin/env
-i PKM_CLI_CONFIG=/x .venv/bin/python -c 'import pkm.mcp.server'` imports.
macOS and Python's locale coercion then add `__CF_USER_TEXT_ENCODING` and
`LC_CTYPE=C.UTF-8` inside the process; tests must allow those two.

## Review Focus

- A `glm` conversation: the CLI must still get the engine's `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` (the z.ai key), and `pkm-mcp` must get neither; a Claude-model conversation must not get an inherited `ANTHROPIC_BASE_URL`. Pinned by the `glm` case of the spawn test in Task 1.
- A kept variable whose value has spaces, quotes, `$` or a newline (a `HOME` under `/Users/a b`) arrives byte-identical, and a kept name the server lacks stays unset rather than empty. Pinned by the launcher unit tests in Task 1.
- The launcher and the credential file are both gone after `close()` and after every failed `create_conversation` (factory error, connect error, cancellation, a failed launcher write). Pinned by the widened glob assertions and the new failure test in Task 1.
- An SDK upgrade that adds an environment variable to the CLI's spawn would be silently dropped by the allow-list. Pinned by the SDK-drift test in Task 1, which fails naming the new key.
- `pkm-mcp` run by hand (Claude Desktop, Claude Code) without `PKM_CLI_CONFIG` still honours `PKM_URL`, and the CLI's documented `PKM_CLI_CONFIG=... PKM_URL=...` operator recipe (`docs/cli.md`, `.claude/skills/pkm/SKILL.md`) keeps working. Pinned in Task 2.

---

### Task 1: Allow-listed environment for the harness and pkm-mcp

**Recommended model:** opus (security property, SDK internals).

**Files:**
- Create: `server/tests/test_assistant_harness_spawn.py`
- Modify: `server/src/pkm/assistant/harness_env.py`
- Modify: `server/src/pkm/assistant/claude_engine.py` (`ClaudeConversation.__init__` and `close`, `ClaudeEngine.create_conversation`, new `_write_launcher`, new module function `harness_cli`)
- Modify: `server/tests/test_assistant_harness_env.py`
- Modify: `server/tests/test_claude_engine.py` (`test_create_conversation_options_and_config_file`, the two `test_assistant_mcp_server_*` spawn tests, every `pkm-assistant-*.json` glob)
- Modify: `server/tests/test_assistant_teardown.py` (its `pkm-assistant-*.json` glob)

**Interfaces:**
- Produces, in `pkm/assistant/harness_env.py`:
  - `HOST_ENV: tuple[str, ...]` = `("PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR")`
  - `SDK_ENV: tuple[str, ...]` = `("CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_SDK_READS_SESSION_STATE")`
  - `ENV_BIN = "/usr/bin/env"`
  - `harness_env_names(harness: HarnessEnv) -> tuple[str, ...]`: `HOST_ENV`, then `SDK_ENV`, then `sorted(harness.env)`, first occurrence kept.
  - `launcher_script(cli: str, names: Sequence[str]) -> str`: raises `ValueError` for a name not matching `^[A-Za-z_][A-Za-z0-9_]*$`.
  - `mcp_server_config(python: str, config_path: str, server_args: Sequence[str]) -> McpStdioServerConfig` (the SDK's TypedDict from `claude_agent_sdk.types`): raises `ValueError` when `python` contains `=`.
- Produces, in `pkm/assistant/claude_engine.py`: `harness_cli() -> str`, and `ClaudeConversation(config_path: Path, read_blocks: BlockReader, launcher_path: Path)`.

- [ ] **Step 1: Write the red spawn test**

`server/tests/test_assistant_harness_spawn.py`, no `# pattern` header (tests are exempt). A fixture writes an executable fake CLI into `tmp_path` whose shebang is `#!{sys.executable}` and which:
- answers `-v` with `2.1.301 (Claude Code)` and exits 0 (the SDK's version probe);
- otherwise dumps `dict(os.environ)` to `<tmp_path>/cli-env.json` (path baked into the script text, since its environment is what is under test);
- reads `argv[argv.index("--mcp-config") + 1]` as JSON, takes `mcpServers.pkm`, builds `[command, *args]`, replaces everything from the interpreter's `-m pkm.mcp.server` onward with `-c <dump to <tmp_path>/mcp-env.json>`, and runs it with `env={**os.environ, **cfg.get("env", {})}`. That merge is what the real CLI does: the review's probe of CLI 2.1.301 saw the MCP server receive the CLI's variables plus the config's `PKM_CLI_CONFIG`;
- exits 3, so `create_conversation` raises and cleans up.

The test patches `SubprocessCLITransport._find_bundled_cli` (from `claude_agent_sdk._internal.transport.subprocess_cli`) to return the fake's path, builds a real `ClaudeEngine` (default `client_factory`, `config_dir=tmp_path`, the `_no_rows` reader from `fake_sdk_client`), sets the planted variables with `monkeypatch.setenv`, and runs `create_conversation(SYSTEM_PROMPT, model)` inside `pytest.raises(Exception)`. A prototype of this ran in 0.3 s.

```python
PLANTED = {
    "OPENAI_API_KEY": "SYNTH-OPENAI", "GOODLINKS_API_KEY": "SYNTH-GL",
    "ZAI_API_KEY": "SYNTH-ZAI", "PKM_URL": "http://evil.invalid",
    "ANTHROPIC_BASE_URL": "http://evil.invalid", "HTTPS_PROXY": "http://p.invalid",
    "https_proxy": "http://p.invalid", "HTTP_PROXY": "http://p.invalid",
    "ALL_PROXY": "http://p.invalid", "NO_PROXY": "*",
}
# added inside every macOS process, and by Python's locale coercion
PROCESS_ADDED = {"__CF_USER_TEXT_ENCODING", "LC_CTYPE"}

@pytest.mark.parametrize("model", ["sonnet", "glm"])
def test_the_harness_cli_gets_only_the_allowed_environment(model, ...):
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
def test_pkm_mcp_gets_only_its_config_path(model, ...):
    mcp_env = json.loads((tmp_path / "mcp-env.json").read_text())
    assert set(mcp_env) - PROCESS_ADDED == {"PKM_CLI_CONFIG"}
```

The engine for `glm` is built with `zai_token="zk-test"`. Add `ClaudeConversation` teardown to the assertions: after the raise, `list(tmp_path.glob("pkm-assistant-*")) == []`.

- [ ] **Step 2: Run it and record the red**

Run: `cd server && uv run pytest tests/test_assistant_harness_spawn.py -q -p no:cacheprovider --no-cov`
Expected: all four FAIL; the CLI dump holds `OPENAI_API_KEY: SYNTH-OPENAI`, `PKM_URL`, `HTTPS_PROXY`, and the MCP dump holds those plus `PKM_CLI_CONFIG`. Keep the failure output for the review package.

- [ ] **Step 3: Write the unit tests for the pure functions**

In `server/tests/test_assistant_harness_env.py`:
- `test_harness_env_names_keeps_host_sdk_and_harness_names`: for `resolve_harness_env("glm", "zk")`, the result starts with `HOST_ENV + SDK_ENV`, contains `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ENABLE_TOOL_SEARCH`, and has no duplicates; for `"sonnet"` it lacks `ANTHROPIC_BASE_URL`.
- `test_no_secret_or_routing_name_is_kept`: none of `OPENAI_API_KEY`, `GOODLINKS_API_KEY`, `ZAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `PKM_URL`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (or their lowercase forms), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` is in `harness_env_names` for any model in `MODELS`.
- `test_launcher_passes_kept_values_byte_identical` (runs the script, so it touches a subprocess; that is fine in a test): write `launcher_script(<fake dumper>, ["HOME", "ODD"])` to `tmp_path`, chmod 0o700, run it with `env={"HOME": "/Users/a b", "ODD": "x \"y\" $z '\n' w", "SECRET": "s"}`; the dumper's JSON has `HOME` and `ODD` exactly and no `SECRET`.
- `test_launcher_leaves_a_missing_name_unset`: running with `HOME` absent gives a dump without `HOME` (not `""`).
- `test_launcher_quotes_the_cli_path`: a dumper at `tmp_path / "it's a cli"` still runs.
- `test_launcher_refuses_a_name_the_shell_would_interpret`: `launcher_script("/x", ["A;rm"])` raises `ValueError`.
- `test_mcp_server_config_runs_pkm_mcp_under_an_empty_environment`: `mcp_server_config("/py", "/c.json", ["--tools", "a,b", "--require-expect"]) == {"type": "stdio", "command": "/usr/bin/env", "args": ["-i", "PKM_CLI_CONFIG=/c.json", "/py", "-m", "pkm.mcp.server", "--tools", "a,b", "--require-expect"]}` (no `env` key).
- `test_mcp_server_config_refuses_an_interpreter_env_would_parse_as_an_assignment`: `"/a=b/python"` raises `ValueError`.

Run: `cd server && uv run pytest tests/test_assistant_harness_env.py -q --no-cov`
Expected: FAIL on import of the new names.

- [ ] **Step 4: Implement the pure functions in `harness_env.py`**

`launcher_script` returns exactly this shape (one `${NAME+"NAME=$NAME"}` word per name, so an unset name adds nothing and a set one passes as a single argument; `exec` keeps the CLI's pid the one the SDK signals):

```sh
#!/bin/sh
exec /usr/bin/env -i ${PATH+"PATH=$PATH"} ${HOME+"HOME=$HOME"} ... '<cli, shlex.quote>' "$@"
```

Update the module docstring and the `HarnessEnv.env` docstring: the env is no longer added on top of the server's, it is the subprocess's whole environment beside `HOST_ENV` and `SDK_ENV`. Put the evidence for `HOST_ENV`'s non-obvious members in one comment beside it (Keychain lookup by `security` on `PATH`, account from `USER`, `CLAUDE_CONFIG_DIR`/`CLAUDE_SECURESTORAGE_CONFIG_DIR` choose the Keychain service), and beside `SDK_ENV` the fact that the SDK sets them in `connect` and `test_assistant_harness_spawn.py` fails when it starts setting another.

Run: `cd server && uv run pytest tests/test_assistant_harness_env.py -q --no-cov` — Expected: PASS.

- [ ] **Step 5: Write the SDK-drift test**

In `test_assistant_harness_spawn.py`, `test_every_variable_the_sdk_sets_is_kept`: monkeypatch `os.environ` to `{"CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK": "1"}`, patch `subprocess_cli.anyio.open_process` with an async fake that records its `env` kwarg and raises a sentinel exception, then `await SubprocessCLITransport(prompt="", options=ClaudeAgentOptions(env=harness.env, cli_path="/x")).connect()` under `pytest.raises`. Assert `set(recorded) - {"CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK"} <= set(harness_env_names(harness))` for `resolve_harness_env("glm", "zk")`. It passes now; it exists to fail on an SDK upgrade.

- [ ] **Step 6: Wire the engine**

In `claude_engine.py`:
- `harness_cli() -> str`: `SubprocessCLITransport(prompt="", options=ClaudeAgentOptions())._find_cli()`. The SDK's own discovery (bundled binary first), called per conversation so a missing CLI still fails at conversation start, not server start. One comment: it is a private SDK method, and the spawn test patches `_find_bundled_cli` beneath it.
- `ClaudeEngine._write_launcher(self, names: Sequence[str]) -> Path`: `tempfile.mkstemp(prefix="pkm-assistant-", suffix=".sh", dir=self._config_dir)`, write `launcher_script(harness_cli(), names)`, `os.chmod(path, 0o700)`.
- `create_conversation`: after `_write_cli_config()`, write the launcher; if that raises, unlink the config file and re-raise. Pass both paths to `ClaudeConversation`. Options gain `cli_path=launcher_path`, and `mcp_servers={"pkm": mcp_server_config(sys.executable, str(config_path), ["--tools", ",".join(READ_TOOLS + WRITE_TOOLS), "--require-expect"])}` (keep the existing `--require-expect` comment). `env=harness.env` stays.
- `ClaudeConversation.close`'s `finally` unlinks the launcher beside the config file.

- [ ] **Step 7: Update the existing engine tests**

- `test_create_conversation_options_and_config_file`: read `PKM_CLI_CONFIG` from the `PKM_CLI_CONFIG=` element of `server_cfg["args"]`; assert `server_cfg["command"] == "/usr/bin/env"`, `"env" not in server_cfg`, the args after the config element are `[sys.executable, "-m", "pkm.mcp.server", "--tools", ..., "--require-expect"]`; assert `Path(opts.cli_path).parent == tmp_path`, mode `0o700`, and that it is gone after `close()`.
- The two `test_assistant_mcp_server_*` tests: build `StdioServerParameters(command=cfg["command"], args=cfg["args"], env=dict(os.environ))`. They now prove `pkm-mcp` serves its tools under `env -i`.
- Every `glob("pkm-assistant-*.json")` in `test_claude_engine.py` and `test_assistant_teardown.py` becomes `glob("pkm-assistant-*")`.
- Add `test_a_failed_launcher_write_leaves_no_credential_file`: monkeypatch `harness_env.launcher_script` (as imported into `claude_engine`) to raise `OSError`; `create_conversation` raises it, `FakeSDKClient.instances == []`, and `tmp_path.glob("pkm-assistant-*")` is empty.

- [ ] **Step 8: Run the assistant tests**

Run: `cd server && uv run pytest tests/test_assistant_harness_spawn.py tests/test_assistant_harness_env.py tests/test_claude_engine.py tests/test_assistant_teardown.py -q --no-cov`
Expected: PASS, including the four Step 1 tests that were red.

- [ ] **Step 9: Commit**

```bash
git add server/src/pkm/assistant/harness_env.py server/src/pkm/assistant/claude_engine.py \
  server/tests/test_assistant_harness_spawn.py server/tests/test_assistant_harness_env.py \
  server/tests/test_claude_engine.py server/tests/test_assistant_teardown.py
git commit -m "assistant: start the harness and pkm-mcp with an allow-listed environment"
```

---

### Task 2: pkm-mcp takes its URL from the config file it is handed

**Recommended model:** sonnet.

**Files:**
- Modify: `server/src/pkm/client/api.py` (`load_config`, new `load_mcp_config`)
- Modify: `server/src/pkm/mcp/tools.py` (`_client_factory`)
- Modify: `server/tests/test_client_api.py`
- Modify: `docs/cli.md` (the `PKM_URL` bullet near the top)

**Interfaces:**
- Produces: `load_config(*, honour_pkm_url: bool = True) -> CliConfig` (callers unchanged: `cli/main.py` keeps `PKM_URL`), and `load_mcp_config() -> CliConfig`, which is `load_config(honour_pkm_url=not os.environ.get("PKM_CLI_CONFIG"))`.

Why not change `load_config` itself: `docs/cli.md` (§ title migration) and `.claude/skills/pkm/SKILL.md` tell operators to set `PKM_CLI_CONFIG` **and** `PKM_URL` together for the CLI, so the bean's rule applies to `pkm-mcp` only. Task 1 already keeps `PKM_URL` out of the assistant's `pkm-mcp`; this is the second layer for any `pkm-mcp` started with an explicit config.

- [ ] **Step 1: Write the failing tests** in `test_client_api.py`

- `test_mcp_config_ignores_pkm_url_when_a_config_file_is_named`: `PKM_CLI_CONFIG` set, `save_config(CliConfig(url="http://127.0.0.1:1", token="t"))`, `PKM_URL=http://evil.invalid` → `load_mcp_config().url == "http://127.0.0.1:1"`.
- `test_mcp_config_honours_pkm_url_with_the_default_config_path`: `PKM_CLI_CONFIG` unset, `HOME` set to `tmp_path`, config saved at the default path, `PKM_URL=http://other:2/` → `load_mcp_config().url == "http://other:2"`.
- `test_the_mcp_client_factory_uses_the_mcp_config`: both variables set as in the first test → `mcp_tools._client_factory()._config.url == "http://127.0.0.1:1"`.
- `test_load_config_pkm_url_override` stays as it is (the CLI keeps the override).

Run: `cd server && uv run pytest tests/test_client_api.py -q --no-cov` — Expected: FAIL (`load_mcp_config` undefined; the factory test gets the evil URL).

- [ ] **Step 2: Implement** `load_config(*, honour_pkm_url=True)`, `load_mcp_config()`, and switch `mcp/tools.py`'s `_client_factory` to `load_mcp_config`. `load_mcp_config`'s docstring says why: started with an explicit config, as the in-app assistant starts it, the file's URL is the only URL, so the server's environment cannot redirect the session token.

- [ ] **Step 3: Run** `cd server && uv run pytest tests/test_client_api.py tests/test_mcp_server.py -q --no-cov` — Expected: PASS.

- [ ] **Step 4: Document** in `docs/cli.md`'s `PKM_URL` bullet: `pkm-mcp` ignores it when `PKM_CLI_CONFIG` is set.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/client/api.py server/src/pkm/mcp/tools.py server/tests/test_client_api.py docs/cli.md
git commit -m "pkm-mcp: ignore PKM_URL when PKM_CLI_CONFIG names the config"
```

---

### Task 3: Python dependency upgrades

**Recommended model:** sonnet.

**Files:**
- Modify: `server/pyproject.toml` (`"mcp>=1.28"` becomes `"mcp>=1.30,<2"`)
- Modify: `server/uv.lock`

- [ ] **Step 1: Record the red audit**

```bash
cd server && uv export --frozen --no-hashes --all-groups --no-emit-project > "$TMPDIR/oirq-reqs.txt"
uvx pip-audit -r "$TMPDIR/oirq-reqs.txt" --no-deps --disable-pip
```
Expected: `Found 31 known vulnerabilities in 7 packages` (pyjwt, cryptography, mcp, anyio, httpx2, httpcore2, certifi). A different count means the advisory database moved; read the new entries before going on.

- [ ] **Step 2: Bound mcp and upgrade**

Edit the `mcp` requirement, then:
```bash
cd server && uv lock --upgrade-package pyjwt --upgrade-package cryptography --upgrade-package mcp \
  --upgrade-package anyio --upgrade-package httpx2 --upgrade-package httpcore2 --upgrade-package certifi
uv sync
```
Expected lock changes: exactly the versions in the Measured upgrade set table, plus `httpx2-jsfetch` 1.0 added. Run `uv tree --invert --package httpx2-jsfetch` and put what pulls it in the commit message. Python stays 3.12.10 (`uv run python -V`), SQLite 3.47.1.

- [ ] **Step 3: Green audit**

Re-run Step 1's two commands. Expected: `No known vulnerabilities found`.

- [ ] **Step 4: Server gates**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: all pass, coverage at or above the enforced floor. A failure from the httpx2 2.5 to 2.16 jump is fixed in the calling code, not by holding httpx2 back below 2.12.0 (its last advisory's fix).

- [ ] **Step 5: Commit**

```bash
git add server/pyproject.toml server/uv.lock
git commit -m "server: upgrade pyjwt, cryptography, mcp, anyio, httpx2, httpcore2, certifi for advisories"
```
The message lists the advisory count before and after and the mcp<2 bound with its reason.

---

### Task 4: Web dependency upgrades and the mermaid mirror re-check

**Recommended model:** opus (the mermaid safety rules mirror mermaid internals; deciding they still hold is security judgement).

**Files:**
- Modify: `web/package.json`, `web/pnpm-lock.yaml`, `web/pnpm-workspace.yaml` (the `katex` override and its comment)
- Possibly modify: `web/src/components/mermaidSafety.ts` and its test, only if Step 3 finds drift

- [ ] **Step 1: Record the red audit**

Run: `cd web && pnpm audit --prod`
Expected: 15 advisories (1 critical, 1 high, 8 moderate, 5 low) in mermaid, dompurify, katex, react-router, react-router-dom.

- [ ] **Step 2: Upgrade**

```bash
cd web && pnpm add mermaid@~11.16.1 katex@^0.18.10 react-router-dom@^6.30.6
```
Set the `katex` override in `pnpm-workspace.yaml` to `^0.18.10` (the override, not `package.json`, decides the installed katex: with only `package.json` changed, 0.17.0 stays), rewrite that comment's version numbers to the new ones (mermaid 11.16.1 asks for `katex ^0.16.45`), and drop the bean id from the comment while editing it. Then `pnpm install && pnpm update dompurify`.
Check: `grep -nE "^  (mermaid|dompurify|katex|react-router|react-router-dom)@" pnpm-lock.yaml` shows mermaid 11.16.1, dompurify 3.4.17, katex 0.18.10, react-router and react-router-dom 6.30.6, and `pnpm why dompurify` finds one version.

Why `~11.16.1` and not `^`: `mermaidSafety.ts` restates mermaid internals, so a new mermaid minor needs Step 3 again; a caret would let `pnpm update` take 11.17 without it.

- [ ] **Step 3: Re-check the mermaid mirrors against the installed 11.16.1**

Each rule below restates something in mermaid; confirm it against `node_modules/.pnpm/mermaid@11.16.1/node_modules/mermaid/dist/chunks/mermaid.core/*.mjs` and write the result (holds / changed, with the mermaid symbol) into the commit message:
- `MERMAID_DEFAULT_SECURE` against `defaultConfig.secure` (the unit test `keeps every secure key the installed mermaid secures by default` checks this one at runtime).
- `asMermaidReadsEntities` and `ENTITY` against mermaid's `encodeEntities` (drops one trailing `;` from `style`/`classDef` lines, then rewrites `#123;` and `#name;`) and `decodeEntities`. Measured already: `encodeEntities` is byte-identical in 11.16.0, 11.16.1 and 11.17.2.
- `STOCK_MERMAID_SECURE`'s CSS keys (`themeCSS`, `themeVariables`, `fontFamily`, `altFontFamily`) against how 11.16.1 builds diagram CSS: advisory GHSA-6x64-9x62-f2gx, fixed in this release, was CSS injection reaching sibling elements, so this path changed.
- `STOCK_MERMAID_DOMPURIFY` against dompurify 3.4.17's defaults (the critical GHSA-cg2g-xh64-v4q7 and high GHSA-mrv2-3pqr-j5jr fixes are in `SAFE_FOR_TEMPLATES` and `IN_PLACE` modes, which the app's config does not set; confirm that).
- `SHAPE_DATA`/`IMG_KEY` (`@{ img: }`) and `ACTOR_PROPERTIES` against any new image-loading syntax in the release.
If a rule no longer matches, fix it test-first in `mermaidSafety.test.ts`.

- [ ] **Step 4: Run the specs that exercise the upgraded libraries**

```bash
cd web && set -o pipefail && pnpm test:unit && pnpm build \
  && E2E_PORT=8981 node tooling/runPlaywright.mjs e2e/external-media.spec.ts e2e/math.spec.ts
```
Expected: PASS. `external-media.spec.ts` is the mermaid probes (`IMG_LABEL`, `THEME_CSS`, `IMG_SHAPE`, `PLAIN`) and must show no outbound request; `math.spec.ts` checks `.katex` and `.katex-display`, which KaTeX 0.18's class prefixing (its one breaking change) must not have renamed.

- [ ] **Step 5: Green audit**

Run: `cd web && pnpm audit --prod`
Expected: exactly the two `react-router >=6.0.0 <7.18.0` advisories (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg) and nothing else.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml   # plus mermaidSafety files if changed
git commit -m "web: upgrade mermaid, dompurify, katex, react-router-dom for advisories"
```
The message carries Step 3's findings and names the two remaining react-router advisories with why they are not reachable (see the Measured upgrade set).

---

### Task 5: Docs

**Recommended model:** sonnet. Invoke the `architecture-docs` skill first.

**Files:**
- Modify: `docs/architecture/assistant.md` § Harness confinement
- Modify: `docs/troubleshooting.md` § Assistant
- Modify: `deploy/README.md` § Assistant prerequisites

- [ ] **Step 1: assistant.md.** Add an `Environment` row to the Harness confinement table: mechanism = `cli_path` is a per-conversation launcher (`harness_env.launcher_script`) that runs the CLI under `env -i` with `harness_env_names()`; `pkm-mcp` runs under `env -i` with only `PKM_CLI_CONFIG` (`mcp_server_config`). Rule = the SDK merges `os.environ` under `options.env` and offers no way to remove a variable, so the allow-list lives in the launcher; a variable the CLI needs must be added to `HOST_ENV` (the drift test catches SDK-set ones, nothing catches a CLI need, so a live start is the check). Rewrite the `Auth` row's "The token is visible in the subprocess env" (the env carries the file's path, the token is in the 0600 file), and extend the `Transactional startup` row to say the launcher is removed with the config file.
- [ ] **Step 2: troubleshooting.md.** One row under Assistant: symptom "The harness and its `pkm-mcp` received the service's whole environment: `OPENAI_API_KEY`, `GOODLINKS_API_KEY`, `ZAI_API_KEY`, `PKM_URL`, proxy variables (security review 2026-10-23)"; cause: the SDK spawns the CLI with `{**os.environ, **options.env}` and the CLI passes its environment to MCP servers; where: assistant.md § Harness confinement; ref: `pkm-oirq`.
- [ ] **Step 3: deploy/README.md.** In Assistant prerequisites: the harness gets only the allow-listed variables, so a proxy, `ANTHROPIC_BASE_URL` or `CLAUDE_CODE_OAUTH_TOKEN` in the service environment does not reach it, while `HOME`, `USER` and a `CLAUDE_CONFIG_DIR` do. Link assistant.md rather than listing the names (the code holds the list).
- [ ] **Step 4: Commit** the three files: `docs: the harness environment allow-list (added); the Auth row's token claim (corrected)`.

---

### Task 6: Live check and branch gates

**Recommended model:** opus (judging a live harness start against Arthur's real login).

- [ ] **Step 1: Live start with the real CLI and login.** Start a scratch server on port 8981 per the `verify` skill (never 8974). In the assistant panel, pick a Claude model (`sonnet` or `haiku`) and ask a question that needs a read tool (for example "what pages mention X?"). Expected: a reply that used a `pkm` tool. This is the only check that the allow-list keeps everything the bundled CLI needs for the Keychain login; if it fails, read the CLI's stderr in the server log, add the variable it needed to `HOST_ENV` with its evidence, and re-run Task 1's tests. `glm` is covered by Task 1's tests and is not run live unless a z.ai key is configured for the scratch server. Stop the server by PID.
- [ ] **Step 2: Gates**, each must pass:
  - `cd server && uv run pytest -q`
  - `cd server && uv run pyrefly check`
  - `cd server && uv run ruff check`
  - `PYTHONPATH=server/tooling python3 -m commentlint.run --all` (from the worktree root)
  - `cd web && set -o pipefail && E2E_PORT=8981 pnpm verify`
- [ ] **Step 3: Perf.** `perf/check.sh` (both sides changed: the server's anyio/httpx2 and the web's mermaid/katex). No Python or SQLite bump, so no `--bootstrap` is expected; a regression is investigated per AGENTS.md. Include the table in the review package. The property gate is not needed: nothing in sync, ops, planning, outline commands or undo changed.
- [ ] **Step 4:** Commit any baseline file perf rewrote, by path.
