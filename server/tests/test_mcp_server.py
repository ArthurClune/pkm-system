import pytest

from pkm.mcp import server as mcp_server


@pytest.fixture()
def tools(pkm_client, monkeypatch):
    monkeypatch.setattr(mcp_server, "_client_factory", lambda: pkm_client)
    monkeypatch.setattr(mcp_server, "_cached_client", None)
    return mcp_server


def test_tools_are_registered(tools):
    names = {t.name for t in tools.mcp._tool_manager.list_tools()}
    assert names == {"get_page", "get_block", "search", "query", "backlinks",
                     "todos", "save_note", "update_block", "batch",
                     "upload_asset"}


def test_get_page_markdown_includes_uids(tools):
    out = tools.get_page("Machine Learning")
    assert out.startswith("# Machine Learning\n")
    assert "^uid_b1" in out


def test_get_block(tools):
    assert tools.get_block("uid_b3").startswith(
        "(in: Machine Learning > Papers)")


def test_search_query_backlinks_todos(tools):
    assert "## Blocks" in tools.search("Papers")
    assert "(1 total)" in tools.query("{and: [[Paper]]}")
    assert tools.backlinks("Machine Learning").startswith("# Backlinks:")
    assert "(0 total)" in tools.todos()


def test_save_note_returns_uids_and_writes(tools, pkm_client):
    out = tools.save_note("hello from mcp", page="AI")
    assert out.startswith("created ^")
    page = pkm_client.get_page("AI")
    assert any(n["text"] == "hello from mcp" for n in page["blocks"])


def test_save_note_todo_and_outline(tools, pkm_client):
    tools.save_note("task\n  detail", page="AI", todo=True)
    assert pkm_client.todos(page="AI")["total"] == 1


def test_update_block_text_and_mark(tools, pkm_client):
    tools.save_note("temp", page="AI")
    uid = next(n["uid"] for n in pkm_client.get_page("AI")["blocks"]
               if n["text"] == "temp")
    assert tools.update_block(uid, text="edited") == f"updated ^{uid}"
    assert tools.update_block(uid, mark="TODO") == f"updated ^{uid}"
    assert pkm_client.get_block(uid)["block"]["text"] == "{{TODO}} edited"


def test_update_block_requires_exactly_one_change(tools):
    with pytest.raises(ValueError, match="exactly one"):
        tools.update_block("uid_b6")
    with pytest.raises(ValueError, match="exactly one"):
        tools.update_block("uid_b6", text="x", mark="DONE")


def test_batch(tools, pkm_client):
    out = tools.batch([
        {"command": "create", "params": {"page": "AI", "text": "b1"}},
        {"command": "create", "params": {"page": "AI", "text": "b2"}},
    ])
    assert out == "applied 2 ops"


def test_upload_asset(tools, pkm_client, tmp_path):
    f = tmp_path / "pic.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 50)
    out = tools.upload_asset(str(f), page="AI")
    assert "/assets/" in out and "created ^" in out


def test_upload_asset_missing_file(tools):
    with pytest.raises(ValueError, match="no such file"):
        tools.upload_asset("/nonexistent/x.png")
