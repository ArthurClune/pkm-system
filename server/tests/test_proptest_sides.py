from proptest.run import web_command
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
