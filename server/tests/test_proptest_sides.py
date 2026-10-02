from proptest.sides import available, sides_for


def test_server_paths_pick_server():
    assert sides_for(["server/src/pkm/ops_core.py"]) == ["server"]


def test_web_e2e_and_markdown_pick_nothing():
    assert sides_for(["web/e2e/a.spec.ts", "web/README.md"]) == []


def test_both_sides_in_fixed_order():
    assert sides_for(["web/src/x.ts", "server/y.py"]) == ["server", "web"]


def test_docs_pick_nothing():
    assert sides_for(["docs/architecture/backend.md"]) == []


def test_only_server_is_available_yet():
    assert available("server") and not available("web")
