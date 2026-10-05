from proptest.run import web_command, web_env
from proptest.sides import available, sides_for


def test_server_src_picks_both_sides():
    assert sides_for(["server/src/pkm/ops_core.py"]) == ["server", "web"]


def test_web_e2e_and_markdown_pick_nothing():
    assert sides_for(["web/e2e/a.spec.ts", "web/README.md"]) == []


def test_both_sides_in_fixed_order():
    assert sides_for(["web/src/x.ts", "server/y.py"]) == ["server", "web"]


def test_docs_pick_nothing():
    assert sides_for(["docs/architecture/backend.md"]) == []


def test_both_sides_available():
    assert available("server") and available("web")


def test_server_route_change_picks_both_sides():
    assert sides_for(["server/src/pkm/server/routes_ops.py"]) == ["server", "web"]


def test_server_test_picks_server_only():
    assert sides_for(["server/tests/x.py"]) == ["server"]


def test_sync_server_launcher_picks_both_sides():
    assert sides_for(["server/tooling/proptest/sync_server.py"]) == ["server", "web"]


def test_web_command():
    expected = ["pnpm", "exec", "vitest", "run", "--config", "vitest.props.config.ts"]
    assert web_command(None) == expected
    assert web_command(7) == expected


def test_web_env_carries_the_server_alone_by_default():
    assert web_env(8978, None, None, None) == {
        "PROPTEST_BASE_URL": "http://127.0.0.1:8978", "PROPTEST_PASSWORD": "proptest-pw"}


def test_web_env_forwards_seed_path_and_replay_path():
    env = web_env(8978, 42, "3:1:0", "AAB")
    assert env["PROPTEST_SEED"] == "42"
    assert env["PROPTEST_PATH"] == "3:1:0"
    assert env["PROPTEST_REPLAY_PATH"] == "AAB"


def test_web_command_appends_a_file_filter():
    base = ["pnpm", "exec", "vitest", "run", "--config", "vitest.props.config.ts"]
    assert web_command(None, "outline/outline.prop.ts") == [*base, "outline/outline.prop.ts"]
    assert web_command(7, None) == base


def test_file_is_web_only(capsys):
    from proptest.run import main
    assert main(["server", "--file", "x.prop.ts"]) == 2
    assert "--file is web only" in capsys.readouterr().err
