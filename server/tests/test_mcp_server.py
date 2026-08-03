import pytest

from pkm.cli.build import BuildError
from pkm.client.core import ApiError
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
                     "upload_asset", "search_assets"}


def test_get_page_markdown_includes_uids(tools):
    out = tools.get_page("Machine Learning")
    assert out.startswith("# Machine Learning\n")
    assert "^uid_b1" in out


def test_get_page_normalizes_control_whitespace_title(tools, pkm_client):
    pkm_client.post_ops([
        {"op": "create_page", "page_title": "Ctrl\tTitle"},
        {"op": "create", "uid": "mcpgetctrl01", "page_title": "Ctrl\tTitle",
         "parent_uid": None, "order_idx": 0, "text": "mcp body"},
    ], batch_id="mcp-get-ctrlws-0001")

    out = tools.get_page("Ctrl\tTitle")

    assert out.startswith("# Ctrl Title\n")
    assert "mcp body" in out


def test_get_block(tools):
    assert tools.get_block("uid_b3").startswith(
        "(in: Machine Learning > Papers)")


def test_search_query_backlinks_todos(tools):
    assert "## Blocks" in tools.search("Papers")
    assert "(1 total)" in tools.query("{and: [[Paper]]}")
    assert tools.backlinks("Machine Learning").startswith("# Backlinks:")
    assert "(0 total)" in tools.todos()


def test_backlinks_normalizes_control_whitespace_title(tools, pkm_client):
    pkm_client.post_ops([
        {"op": "create_page", "page_title": "Ctrl\tTitle"},
        {"op": "create", "uid": "mcprefsctrl1", "page_title": "Ctrl Source",
         "parent_uid": None, "order_idx": 0, "text": "See [[Ctrl Title]]"},
    ], batch_id="mcp-refs-ctrlws-0001")

    out = tools.backlinks("Ctrl\tTitle")

    assert "## Ctrl Source" in out
    assert "See [[Ctrl Title]]" in out


def test_backlinks_returns_every_group_beyond_the_single_page_cap(
        tools, seed_backlinks):
    # Same pagination cap as the CLI's `pkm refs` (pkm-3cyg): the MCP tool
    # must not silently drop groups past the route's 100-group limit.
    seed_backlinks(101)
    out = tools.backlinks("Machine Learning")
    assert out.startswith("# Backlinks: Machine Learning (102 pages)")
    assert "## BL Source 000" in out
    assert "## BL Source 100" in out


def test_search_exact_and_query_expand(tools):
    assert tools.search("machi", exact=True) == "no results\n"
    assert "uid_b4" in tools.query("{and: [[AI]]}", expand=True)


def test_save_note_returns_uids_and_writes(tools, pkm_client):
    out = tools.save_note("hello from mcp", page="AI")
    assert out.startswith("created ^")
    page = pkm_client.get_page("AI")
    assert any(n.text == "hello from mcp" for n in page.blocks)


def test_save_note_propagates_forbidden_page_title_server_error(
        tools, pkm_client):
    with pytest.raises(ApiError) as exc:
        tools.save_note("must not land", page="New #Old")

    assert str(exc.value) == (
        "400: op 0: unsupported page_title title syntax: 'New #Old'"
    )
    with pytest.raises(ApiError) as missing:
        pkm_client.get_page("New #Old")
    assert missing.value.status == 404


def test_missing_page_error_has_one_status_prefix(tools):
    with pytest.raises(ApiError) as exc:
        tools.get_page("No Such Page")
    assert str(exc.value) == "404: page not found"


def test_save_note_todo_and_outline(tools, pkm_client):
    tools.save_note("task\n  detail", page="AI", todo=True)
    assert pkm_client.todos(page="AI").total == 1


def test_save_note_twice_to_a_control_whitespace_titled_page_appends_and_reuses_the_heading(
        tools, pkm_client):
    """Mirrors the CLI regression (pkm-5k8p): a title with control
    whitespace normalizes at creation (pkm-hjhy), so a second save_note
    call using the same raw spelling must see the page's real blocks
    instead of a false-empty placeholder."""
    tools.save_note("first", page="Ctrl\tTitle", parent="## Notes")
    tools.save_note("second", page="Ctrl\tTitle", parent="## Notes")
    page = pkm_client.get_page("Ctrl Title")
    headings = [n for n in page.blocks if n.text == "Notes"]
    assert len(headings) == 1
    assert [c.text for c in headings[0].children] == ["first", "second"]


def test_update_block_text_and_mark(tools, pkm_client):
    tools.save_note("temp", page="AI")
    uid = next(n.uid for n in pkm_client.get_page("AI").blocks
               if n.text == "temp")
    assert tools.update_block(uid, text="edited") == f"updated ^{uid}"
    assert tools.update_block(uid, mark="TODO") == f"updated ^{uid}"
    assert pkm_client.get_block(uid).block.text == "{{TODO}} edited"


def test_update_block_requires_exactly_one_change(tools):
    with pytest.raises(ValueError, match="exactly one"):
        tools.update_block("uid_b6")
    with pytest.raises(ValueError, match="exactly one"):
        tools.update_block("uid_b6", text="x", mark="DONE")


def test_update_block_rejects_an_unknown_mark(tools):
    # Only the two task markers the todo syntax defines; anything else
    # would be written into the block text verbatim.
    with pytest.raises(ValueError, match="TODO"):
        tools.update_block("uid_b6", mark="MAYBE")


def test_batch(tools, pkm_client):
    out = tools.batch([
        {"command": "create", "params": {"page": "AI", "text": "b1"}},
        {"command": "create", "params": {"page": "AI", "text": "b2"}},
    ])
    assert out == "applied 2 ops"


def test_batch_propagates_indexed_forbidden_reference_server_error(
        tools, pkm_client):
    commands = [
        {"command": "create", "params": {"page": "AI", "text": "first"}},
        {"command": "create",
         "params": {"page": "AI", "text": "[[New #Old]]"}},
    ]

    with pytest.raises(ApiError) as exc:
        tools.batch(commands)

    assert str(exc.value) == (
        "400: op 1: unsupported reference title syntax: 'New #Old'"
    )
    assert all(node.text != "first" for node in pkm_client.get_page("AI").blocks)


def test_save_note_empty_text_on_new_page_leaves_no_page_behind(tools, pkm_client):
    # plan_save rejects empty text after the page would already have been
    # fetched/created -- the page must not persist when the save as a
    # whole fails (pkm-w80k: page creation rides the same atomic batch).
    with pytest.raises(BuildError, match="empty"):
        tools.save_note("", page="Brand New Page")
    with pytest.raises(ApiError) as e:
        pkm_client.get_page("Brand New Page")
    assert e.value.status == 404


def test_batch_failure_after_new_page_leaves_no_page_or_blocks(tools, pkm_client):
    cmds = [
        {"command": "create",
         "params": {"page": "Brand New Page", "text": "hello"}},
        {"command": "zap", "params": {}},
    ]
    with pytest.raises(BuildError, match="unknown command"):
        tools.batch(cmds)
    with pytest.raises(ApiError) as e:
        pkm_client.get_page("Brand New Page")
    assert e.value.status == 404


def test_batch_non_object_item_raises(tools):
    with pytest.raises(BuildError, match=r"batch\[0\]"):
        tools.batch(["not a dict"])


def test_batch_missing_field_raises(tools):
    with pytest.raises(BuildError, match=r"batch\[0\].*page"):
        tools.batch([{"command": "create", "params": {"text": "x"}}])


def test_batch_wrong_typed_field_raises(tools):
    with pytest.raises(BuildError, match=r"batch\[0\].*text"):
        tools.batch([{"command": "create",
                     "params": {"page": "AI", "text": 123}}])


def test_batch_negative_index_raises(tools):
    with pytest.raises(BuildError, match=r"batch\[0\].*index"):
        tools.batch([{"command": "create",
                     "params": {"page": "AI", "text": "x", "index": -1}}])


def test_batch_unknown_alias_raises(tools):
    with pytest.raises(BuildError, match="unknown alias"):
        tools.batch([{"command": "create",
                     "params": {"page": "AI", "text": "x",
                                "parent": "{{nope}}"}}])


def test_batch_nested_but_empty_outline_items_raises(tools):
    # items=[[]] flattens to zero leaf strings -- must fail loudly, not
    # silently apply a zero-op batch.
    with pytest.raises(BuildError, match=r"batch\[0\].*items"):
        tools.batch([{"command": "outline",
                     "params": {"page": "AI", "items": [[]]}}])


def test_batch_schema_failure_leaves_no_page_or_blocks(tools, pkm_client):
    # A schema-invalid second command must fail the whole batch before the
    # first command's brand-new page is fetched/created at all (pkm-4w23:
    # validation runs before any page discovery or I/O).
    cmds = [
        {"command": "create",
         "params": {"page": "Brand New MCP Batch Page", "text": "hello"}},
        {"command": "create", "params": {"page": "AI", "text": 123}},
    ]
    with pytest.raises(BuildError, match=r"batch\[1\].*text"):
        tools.batch(cmds)
    with pytest.raises(ApiError) as e:
        pkm_client.get_page("Brand New MCP Batch Page")
    assert e.value.status == 404


def test_upload_asset(tools, pkm_client, tmp_path):
    f = tmp_path / "pic.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 50)
    out = tools.upload_asset(str(f), page="AI")
    assert "/assets/" in out and "created ^" in out


def test_upload_asset_missing_file(tools):
    with pytest.raises(ValueError, match="no such file"):
        tools.upload_asset("/nonexistent/x.png")


def test_upload_asset_invalid_parent_is_rejected_before_any_upload(
        tools, pkm_client, tmp_path):
    f = tmp_path / "pic.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 50)
    with pytest.raises(BuildError, match="not on page"):
        tools.upload_asset(str(f), page="AI", parent="((no-such-uid))")
    assert pkm_client.search_assets("pic.png").total == 0


def test_upload_asset_post_ops_failure_deletes_the_orphaned_asset(
        tools, pkm_client, tmp_path, monkeypatch):
    f = tmp_path / "pic.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 50)

    def _fail(ops, batch_id):
        raise ApiError(500, "boom")

    monkeypatch.setattr(pkm_client, "post_ops", _fail)
    with pytest.raises(ApiError):
        tools.upload_asset(str(f), page="AI")
    assert pkm_client.search_assets("pic.png").total == 0


def test_upload_asset_post_ops_failure_does_not_delete_a_pre_existing_asset(
        tools, pkm_client, tmp_path, monkeypatch):
    f = tmp_path / "pic.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 50)
    tools.upload_asset(str(f), page="AI")  # lands for real -- now in use

    def _fail(ops, batch_id):
        raise ApiError(500, "boom")

    monkeypatch.setattr(pkm_client, "post_ops", _fail)
    with pytest.raises(ApiError):
        tools.upload_asset(str(f), page="Machine Learning")
    assert pkm_client.search_assets("pic.png").total == 1


def test_search_assets(tools, tmp_path):
    f = tmp_path / "diagram.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 50)
    tools.upload_asset(str(f), page="AI")
    out = tools.search_assets("diagram")
    assert "diagram.png" in out
    assert "/assets/" in out
    assert tools.search_assets("nothing-matches-this") == "no assets found"


def test_get_page_resolve_refs(tools):
    out = tools.get_page("July 7th, 2026", resolve_refs=True)
    assert '"[[Attention Is All You Need]] is a [[Paper]]" ((uid_b3))' in out


def test_save_note_heading_levels(tools, pkm_client):
    tools.save_note("# Big", page="AI")
    page = pkm_client.get_page("AI")
    assert any(n.text == "Big" and n.heading == 1
               for n in page.blocks)


def test_update_block_sets_heading_and_mark_preserves_it(tools, pkm_client):
    tools.save_note("temp", page="AI")
    uid = next(n.uid for n in pkm_client.get_page("AI").blocks
               if n.text == "temp")
    tools.update_block(uid, text="### Section")
    block = pkm_client.get_block(uid).block
    assert (block.text, block.heading) == ("Section", 3)
    tools.update_block(uid, mark="TODO")
    block = pkm_client.get_block(uid).block
    assert (block.text, block.heading) == ("{{TODO}} Section", 3)
