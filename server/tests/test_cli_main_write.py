import io
import json

import pytest

from pkm.cli.main import main
from pkm.client.core import ApiError
from pkm.contracts.daily import title_for_date


@pytest.fixture()
def run(pkm_client, capsys, monkeypatch):
    def _run(*argv: str, stdin: str | None = None) -> tuple[int, str, str]:
        if stdin is not None:
            monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
        code = main(list(argv), make_client=lambda: pkm_client)
        out, err = capsys.readouterr()
        return code, out, err
    return _run


def _page_texts(pkm_client, title):
    def _flat(nodes):
        for n in nodes:
            yield n.text
            yield from _flat(n.children)
    return list(_flat(pkm_client.get_page(title).blocks))


def test_save_to_named_page(run, pkm_client):
    code, out, _ = run("save", "-p", "AI", "quick note")
    assert code == 0
    assert out.startswith("created ^")
    assert "quick note" in _page_texts(pkm_client, "AI")


def test_save_defaults_to_today(run, pkm_client):
    from datetime import date
    code, _, _ = run("save", "note for today")
    assert code == 0
    assert "note for today" in _page_texts(
        pkm_client, title_for_date(date.today()))


def test_save_creates_missing_page(run, pkm_client):
    code, _, _ = run("save", "-p", "Brand New Page", "first note")
    assert code == 0
    assert "first note" in _page_texts(pkm_client, "Brand New Page")


def test_save_propagates_forbidden_page_title_server_error(run, pkm_client):
    code, out, err = run("save", "-p", "New #Old", "must not land")

    assert code == 1
    assert out == ""
    assert (
        "400: op 0: unsupported page_title title syntax: 'New #Old'"
        in err
    )
    with pytest.raises(ApiError) as missing:
        pkm_client.get_page("New #Old")
    assert missing.value.status == 404


def test_save_stdin_outline_nests(run, pkm_client):
    code, out, _ = run("save", "-p", "AI", "-",
                       stdin="- [[Henderson]]\n  detail line\n")
    assert code == 0
    texts = _page_texts(pkm_client, "AI")
    assert "- [[Henderson]]" in texts  # leading '-' is content, not a flag
    assert "detail line" in texts


def test_save_todo_flag(run, pkm_client):
    run("save", "-p", "AI", "--todo", "follow up")
    assert "{{TODO}} follow up" in _page_texts(pkm_client, "AI")


def test_save_under_new_heading(run, pkm_client):
    code, _, _ = run("save", "-p", "AI", "--parent", "## Notes", "beneath")
    assert code == 0
    page = pkm_client.get_page("AI")
    heading = next(n for n in page.blocks if n.text == "Notes")
    assert heading.heading == 2
    assert heading.children[0].text == "beneath"


def test_save_twice_to_a_control_whitespace_titled_page_appends_and_reuses_the_heading(
        run, pkm_client):
    """A page title holding control whitespace (e.g. a stray tab) is
    normalized at creation -- "Ctrl\tTitle" is only ever stored, and
    addressable, as "Ctrl Title". A second `pkm save` to the SAME raw
    (pre-normalization) title must see the page's real, already-saved
    blocks -- not a false-empty placeholder that would reset the append
    position to the top of the page and mint a second "## Notes" heading
    the first save already created."""
    run("save", "-p", "Ctrl\tTitle", "--parent", "## Notes", "first")
    code, _, _ = run("save", "-p", "Ctrl\tTitle", "--parent", "## Notes", "second")
    assert code == 0
    page = pkm_client.get_page("Ctrl Title")
    headings = [n for n in page.blocks if n.text == "Notes"]
    assert len(headings) == 1
    assert [c.text for c in headings[0].children] == ["first", "second"]


def test_update_text(run, pkm_client):
    code, out, _ = run("update", "uid_b6", "rewritten")
    assert code == 0
    assert out == "updated ^uid_b6\n"
    assert pkm_client.get_block("uid_b6").block.text == "rewritten"


def test_update_done_and_todo_flags(run, pkm_client):
    run("save", "-p", "AI", "--todo", "task x")
    uid = pkm_client.todos(page="AI").groups[0].items[0].uid
    run("update", uid, "-D")
    assert pkm_client.get_block(uid).block.text == "{{DONE}} task x"
    run("update", uid, "-T")
    assert pkm_client.get_block(uid).block.text == "{{TODO}} task x"


def test_update_stdin_strips_trailing_newline(run, pkm_client):
    code, _, _ = run("update", "uid_b6", "-", stdin="rewritten\n")
    assert code == 0
    assert pkm_client.get_block("uid_b6").block.text == "rewritten"


def test_update_stdin_strips_multiple_trailing_newlines_only(run, pkm_client):
    code, _, _ = run("update", "uid_b6", "-", stdin="rewritten  \n\n")
    assert code == 0
    assert pkm_client.get_block("uid_b6").block.text == "rewritten  "


def test_update_requires_exactly_one_change(run):
    code, _, err = run("update", "uid_b6")
    assert code == 1
    assert "one of" in err


def test_upload_appends_image_block(run, pkm_client, tmp_path):
    png = tmp_path / "pic.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 100)
    code, out, _ = run("upload", str(png), "-p", "AI")
    assert code == 0
    assert "/assets/" in out
    assert any(t.startswith("![pic.png](/assets/")
               for t in _page_texts(pkm_client, "AI"))


def test_upload_no_block(run, pkm_client, tmp_path):
    f = tmp_path / "doc.txt"
    f.write_text("hi")
    code, out, _ = run("upload", str(f), "--no-block")
    assert code == 0
    assert out.startswith("/assets/")
    assert not any("doc.txt" in t for t in _page_texts(pkm_client, "AI"))


def test_upload_invalid_parent_is_rejected_before_any_upload(
        run, pkm_client, tmp_path):
    png = tmp_path / "pic.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 100)
    code, out, err = run("upload", str(png), "-p", "AI",
                         "--parent", "((no-such-uid))")
    assert code == 1
    assert "not on page" in err
    assert out == ""  # nothing printed -- the asset was never uploaded
    assert pkm_client.search_assets("pic.png").total == 0


def test_upload_post_ops_failure_deletes_the_orphaned_asset(
        run, pkm_client, tmp_path, monkeypatch):
    png = tmp_path / "pic.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 100)

    def _fail(ops, batch_id):
        raise ApiError(500, "boom")

    monkeypatch.setattr(pkm_client, "post_ops", _fail)
    code, out, err = run("upload", str(png), "-p", "AI")
    assert code == 1
    assert out == ""  # success output withheld until the link actually lands
    assert pkm_client.search_assets("pic.png").total == 0
    assert not any("pic.png" in t for t in _page_texts(pkm_client, "AI"))


def test_upload_post_ops_failure_does_not_delete_a_pre_existing_asset(
        run, pkm_client, tmp_path, monkeypatch):
    png = tmp_path / "pic.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 100)
    code, _, _ = run("upload", str(png), "-p", "AI")
    assert code == 0  # first upload lands for real -- the asset is now in use

    def _fail(ops, batch_id):
        raise ApiError(500, "boom")

    monkeypatch.setattr(pkm_client, "post_ops", _fail)
    code, _, _ = run("upload", str(png), "-p", "Machine Learning")
    assert code == 1
    # same content re-uploads to the same sha256 (content-addressed) --
    # it must survive since the first upload's block still references it
    assert pkm_client.search_assets("pic.png").total == 1


def test_batch_atomic_create_with_alias(run, pkm_client):
    cmds = [
        {"command": "create",
         "params": {"page": "AI", "text": "[[Meeting]] notes", "as": "mtg"}},
        {"command": "outline",
         "params": {"page": "AI", "parent": "{{mtg}}",
                    "items": ["Attendees", "Actions"]}},
    ]
    code, out, _ = run("batch", stdin=json.dumps(cmds))
    assert code == 0
    assert out == "applied 3 ops\n"
    page = pkm_client.get_page("AI")
    mtg = next(n for n in page.blocks if n.text == "[[Meeting]] notes")
    assert [c.text for c in mtg.children] == ["Attendees", "Actions"]


def _gap_seed(run, pkm_client, page, order, drop):
    """Seed `page` with plain (dense) appends in `order`, then batch-delete
    the `drop` texts by uid -- a delete leaves a gap in order_idx (nothing
    ever renumbers), the same gap a real edit history would, wherever
    `drop` falls between two kept texts in `order`. Returns the surviving
    blocks' order_idx, keyed by text, so a caller can assert the gap is
    really there before testing against it."""
    seed = [{"command": "create", "params": {"page": page, "text": t}}
            for t in order]
    code, _, _ = run("batch", stdin=json.dumps(seed))
    assert code == 0
    page_blocks = pkm_client.get_page(page).blocks
    drop_uids = [n.uid for n in page_blocks if n.text in drop]
    code, _, _ = run("batch", stdin=json.dumps(
        [{"command": "delete", "params": {"uid": u}} for u in drop_uids]))
    assert code == 0
    return {n.text: n.order_idx for n in pkm_client.get_page(page).blocks}


def test_batch_append_lands_last_on_a_page_whose_order_keys_have_a_gap(
        run, pkm_client):
    # "first" and "gap-second" land on order_idx 0 and 5 once the three
    # blocks between them are deleted -- the gap a real edit history
    # leaves (nothing ever renumbers order_idx). A later plain append (no
    # index) must land after both, not between them: the server's
    # ShiftSiblings only moves siblings at/after the append's own
    # order_idx, so an append key chosen by sibling COUNT (2, here) would
    # land second instead of last.
    order = _gap_seed(
        run, pkm_client, "Gappy",
        order=["first", "t1", "t2", "t3", "t4", "gap-second"],
        drop={"t1", "t2", "t3", "t4"})
    assert order == {"first": 0, "gap-second": 5}

    code, _, _ = run("batch", stdin=json.dumps(
        [{"command": "create", "params": {"page": "Gappy", "text": "appended"}}]))
    assert code == 0

    assert _page_texts(pkm_client, "Gappy") == [
        "first", "gap-second", "appended"]


def test_batch_create_at_position_lands_correctly_on_a_page_with_gaps(
        run, pkm_client):
    # Same gap as above (A@0, B@5, C@6): a position-2 create must land
    # before the page's THIRD child (C), not at raw order_idx 2 (which
    # would splice it between A and B instead -- the bug this bean fixes).
    order = _gap_seed(
        run, pkm_client, "Gappy2",
        order=["A", "t1", "t2", "t3", "t4", "B", "C"],
        drop={"t1", "t2", "t3", "t4"})
    assert order == {"A": 0, "B": 5, "C": 6}

    code, _, _ = run("batch", stdin=json.dumps(
        [{"command": "create",
          "params": {"page": "Gappy2", "text": "X", "index": 2}}]))
    assert code == 0
    assert _page_texts(pkm_client, "Gappy2") == ["A", "B", "X", "C"]


def test_batch_mixed_indexed_and_appended_create_compose_in_order(
        run, pkm_client):
    run("batch", stdin=json.dumps(
        [{"command": "create", "params": {"page": "Mixed1", "text": t}}
         for t in ["A", "B"]]))
    code, _, _ = run("batch", stdin=json.dumps([
        {"command": "create",
         "params": {"page": "Mixed1", "text": "X", "index": 0}},
        {"command": "create", "params": {"page": "Mixed1", "text": "Y"}},
    ]))
    assert code == 0
    assert _page_texts(pkm_client, "Mixed1") == ["X", "A", "B", "Y"]


def test_batch_two_indexed_creates_at_index_zero_compose_second_first(
        run, pkm_client):
    run("batch", stdin=json.dumps(
        [{"command": "create", "params": {"page": "Compose1", "text": t}}
         for t in ["A", "B"]]))
    code, _, _ = run("batch", stdin=json.dumps([
        {"command": "create",
         "params": {"page": "Compose1", "text": "X", "index": 0}},
        {"command": "create",
         "params": {"page": "Compose1", "text": "Y", "index": 0}},
    ]))
    assert code == 0
    assert _page_texts(pkm_client, "Compose1") == ["Y", "X", "A", "B"]


def test_batch_two_indexed_creates_at_index_one_compose(run, pkm_client):
    run("batch", stdin=json.dumps(
        [{"command": "create", "params": {"page": "Compose2", "text": t}}
         for t in ["A", "B"]]))
    code, _, _ = run("batch", stdin=json.dumps([
        {"command": "create",
         "params": {"page": "Compose2", "text": "Z", "index": 1}},
        {"command": "create",
         "params": {"page": "Compose2", "text": "W", "index": 1}},
    ]))
    assert code == 0
    assert _page_texts(pkm_client, "Compose2") == ["A", "W", "Z", "B"]


def test_batch_delete_then_indexed_create_counts_against_remaining_siblings(
        run, pkm_client):
    run("batch", stdin=json.dumps(
        [{"command": "create", "params": {"page": "DelCreate1", "text": t}}
         for t in ["A", "B", "C"]]))
    page = pkm_client.get_page("DelCreate1")
    a_uid = next(n.uid for n in page.blocks if n.text == "A")
    code, _, _ = run("batch", stdin=json.dumps([
        {"command": "delete", "params": {"uid": a_uid}},
        {"command": "create",
         "params": {"page": "DelCreate1", "text": "X", "index": 1}},
    ]))
    assert code == 0
    assert _page_texts(pkm_client, "DelCreate1") == ["B", "X", "C"]


def test_batch_indexed_move_within_parent_forwards(run, pkm_client):
    run("batch", stdin=json.dumps(
        [{"command": "create", "params": {"page": "MoveF1", "text": t}}
         for t in ["A", "B", "C", "D"]]))
    page = pkm_client.get_page("MoveF1")
    a_uid = next(n.uid for n in page.blocks if n.text == "A")
    code, _, _ = run("batch", stdin=json.dumps(
        [{"command": "move",
          "params": {"uid": a_uid, "page": "MoveF1", "index": 2}}]))
    assert code == 0
    assert _page_texts(pkm_client, "MoveF1") == ["B", "C", "A", "D"]


def test_batch_indexed_move_within_parent_backwards(run, pkm_client):
    run("batch", stdin=json.dumps(
        [{"command": "create", "params": {"page": "MoveB1", "text": t}}
         for t in ["A", "B", "C", "D"]]))
    page = pkm_client.get_page("MoveB1")
    d_uid = next(n.uid for n in page.blocks if n.text == "D")
    code, _, _ = run("batch", stdin=json.dumps(
        [{"command": "move",
          "params": {"uid": d_uid, "page": "MoveB1", "index": 0}}]))
    assert code == 0
    assert _page_texts(pkm_client, "MoveB1") == ["D", "A", "B", "C"]


def test_batch_indexed_move_onto_its_own_slot_is_a_no_op(run, pkm_client):
    run("batch", stdin=json.dumps(
        [{"command": "create", "params": {"page": "MoveSame1", "text": t}}
         for t in ["A", "B", "C", "D"]]))
    page = pkm_client.get_page("MoveSame1")
    b_uid = next(n.uid for n in page.blocks if n.text == "B")
    code, _, _ = run("batch", stdin=json.dumps(
        [{"command": "move",
          "params": {"uid": b_uid, "page": "MoveSame1", "index": 1}}]))
    assert code == 0
    assert _page_texts(pkm_client, "MoveSame1") == ["A", "B", "C", "D"]


def test_batch_indexed_move_across_parents_lands_at_position(run, pkm_client):
    seed = [
        {"command": "create",
         "params": {"page": "MoveX1", "text": "Home", "as": "home"}},
        {"command": "outline",
         "params": {"page": "MoveX1", "parent": "{{home}}",
                    "items": ["P", "Q"]}},
        {"command": "create", "params": {"page": "MoveX1", "text": "Mover"}},
    ]
    code, _, _ = run("batch", stdin=json.dumps(seed))
    assert code == 0
    page = pkm_client.get_page("MoveX1")
    home = next(n for n in page.blocks if n.text == "Home")
    mover_uid = next(n.uid for n in page.blocks if n.text == "Mover")
    code, _, _ = run("batch", stdin=json.dumps([
        {"command": "move",
         "params": {"uid": mover_uid, "page": "MoveX1",
                    "parent": f"(({home.uid}))", "index": 1}},
    ]))
    assert code == 0
    home = next(n for n in pkm_client.get_page("MoveX1").blocks
               if n.text == "Home")
    assert [c.text for c in home.children] == ["P", "Mover", "Q"]


def test_batch_index_past_the_end_appends_for_create(run, pkm_client):
    run("batch", stdin=json.dumps(
        [{"command": "create", "params": {"page": "PastEnd1", "text": t}}
         for t in ["A", "B"]]))
    code, _, _ = run("batch", stdin=json.dumps(
        [{"command": "create",
          "params": {"page": "PastEnd1", "text": "C", "index": 50}}]))
    assert code == 0
    assert _page_texts(pkm_client, "PastEnd1") == ["A", "B", "C"]


def test_batch_index_past_the_end_appends_for_move(run, pkm_client):
    run("batch", stdin=json.dumps(
        [{"command": "create", "params": {"page": "PastEnd2", "text": t}}
         for t in ["A", "B", "C"]]))
    page = pkm_client.get_page("PastEnd2")
    a_uid = next(n.uid for n in page.blocks if n.text == "A")
    code, _, _ = run("batch", stdin=json.dumps(
        [{"command": "move",
          "params": {"uid": a_uid, "page": "PastEnd2", "index": 50}}]))
    assert code == 0
    assert _page_texts(pkm_client, "PastEnd2") == ["B", "C", "A"]


def test_batch_propagates_indexed_forbidden_reference_server_error(
        run, pkm_client):
    commands = [
        {"command": "create", "params": {"page": "AI", "text": "first"}},
        {"command": "create",
         "params": {"page": "AI", "text": "[[New #Old]]"}},
    ]

    code, out, err = run("batch", stdin=json.dumps(commands))

    assert code == 1
    assert out == ""
    assert (
        "400: op 1: unsupported reference title syntax: 'New #Old'"
        in err
    )
    assert "first" not in _page_texts(pkm_client, "AI")


def test_save_empty_text_on_new_page_leaves_no_page_behind(run, pkm_client):
    # plan_save rejects empty text after the page would already have been
    # fetched/created -- the page must not persist when the save as a
    # whole fails: page creation rides the same atomic batch.
    code, _, err = run("save", "-p", "Brand New Page", "")
    assert code == 1
    assert "empty" in err
    with pytest.raises(ApiError) as e:
        pkm_client.get_page("Brand New Page")
    assert e.value.status == 404


def test_batch_failure_after_new_page_leaves_no_page_or_blocks(run, pkm_client):
    cmds = [
        {"command": "create",
         "params": {"page": "Brand New Page", "text": "hello"}},
        {"command": "zap", "params": {}},
    ]
    code, _, err = run("batch", stdin=json.dumps(cmds))
    assert code == 1
    assert "unknown command" in err
    with pytest.raises(ApiError) as e:
        pkm_client.get_page("Brand New Page")
    assert e.value.status == 404


def test_batch_bad_json_exits_1(run):
    code, _, err = run("batch", stdin="not json")
    assert code == 1
    assert "JSON" in err


def test_batch_unknown_command_exits_1(run):
    code, _, err = run("batch", stdin=json.dumps(
        [{"command": "zap", "params": {}}]))
    assert code == 1
    assert "unknown command" in err


def test_batch_non_object_item_exits_1(run):
    code, _, err = run("batch", stdin=json.dumps(["not a dict"]))
    assert code == 1
    assert "batch[0]" in err


def test_batch_missing_field_exits_1(run):
    code, _, err = run("batch", stdin=json.dumps(
        [{"command": "create", "params": {"text": "x"}}]))
    assert code == 1
    assert "page" in err


def test_batch_wrong_typed_field_exits_1(run):
    code, _, err = run("batch", stdin=json.dumps(
        [{"command": "create", "params": {"page": "AI", "text": 123}}]))
    assert code == 1
    assert "text" in err


def test_batch_negative_index_exits_1(run):
    code, _, err = run("batch", stdin=json.dumps(
        [{"command": "create",
         "params": {"page": "AI", "text": "x", "index": -1}}]))
    assert code == 1
    assert "index" in err


def test_batch_unknown_alias_exits_1(run):
    code, _, err = run("batch", stdin=json.dumps(
        [{"command": "create",
         "params": {"page": "AI", "text": "x", "parent": "{{nope}}"}}]))
    assert code == 1
    assert "unknown alias" in err


def test_batch_nested_but_empty_outline_items_exits_1(run):
    # items=[[]] flattens to zero leaf strings -- must fail loudly, not
    # silently apply a zero-op batch.
    code, _, err = run("batch", stdin=json.dumps(
        [{"command": "outline", "params": {"page": "AI", "items": [[]]}}]))
    assert code == 1
    assert "items" in err


def test_batch_schema_failure_leaves_no_page_or_blocks(run, pkm_client):
    # A schema-invalid second command must fail the whole batch before the
    # first command's brand-new page is fetched/created at all: validation
    # runs before any page discovery or I/O.
    cmds = [
        {"command": "create",
         "params": {"page": "Brand New Batch Page", "text": "hello"}},
        {"command": "create", "params": {"page": "AI", "text": 123}},
    ]
    code, _, err = run("batch", stdin=json.dumps(cmds))
    assert code == 1
    assert "text" in err
    with pytest.raises(ApiError) as e:
        pkm_client.get_page("Brand New Batch Page")
    assert e.value.status == 404


def test_save_heading_text_becomes_a_real_heading(run, pkm_client):
    code, _, _ = run("save", "-p", "AI", "## Overview\n  detail")
    assert code == 0
    page = pkm_client.get_page("AI")
    overview = next(n for n in page.blocks if n.text == "Overview")
    assert overview.heading == 2
    assert overview.children[0].text == "detail"


def test_update_to_a_heading_sets_the_level(run, pkm_client):
    code, _, _ = run("update", "uid_b6", "## Rewritten")
    assert code == 0
    block = pkm_client.get_block("uid_b6").block
    assert (block.text, block.heading) == ("Rewritten", 2)


def test_update_to_plain_text_clears_the_level(run, pkm_client):
    run("update", "uid_b6", "## Rewritten")
    run("update", "uid_b6", "Rewritten again")
    block = pkm_client.get_block("uid_b6").block
    assert (block.text, block.heading) == ("Rewritten again", None)


def test_update_done_flag_keeps_the_heading(run, pkm_client):
    run("update", "uid_b6", "## Task x")
    run("update", "uid_b6", "-D")
    block = pkm_client.get_block("uid_b6").block
    assert (block.text, block.heading) == ("{{DONE}} Task x", 2)


def test_rename_prints_one_line(run, pkm_client):
    code, out, err = run("rename", "Paper", "Papers Renamed")
    assert code == 0
    assert err == ""
    assert out == 'renamed "Paper" -> "Papers Renamed"\n'
    assert pkm_client.get_page("Papers Renamed").page.title == "Papers Renamed"


def test_rename_allow_merge_prints_merged_line(run, pkm_client):
    code, out, err = run("rename", "AI", "Machine Learning", "--allow-merge")
    assert code == 0
    assert err == ""
    assert out == 'merged "AI" into "Machine Learning"\n'


def test_rename_collision_without_allow_merge_hints_the_flag(run):
    code, out, err = run("rename", "AI", "Machine Learning")
    assert code == 1
    assert out == ""
    assert "already exists" in err
    assert "--allow-merge" in err


def test_rename_json_emits_the_response_model(run):
    code, out, err = run("rename", "Paper", "Papers Renamed", "--json")
    assert code == 0
    assert err == ""
    assert json.loads(out) == {"result": "renamed", "title": "Papers Renamed"}


def test_update_addresses_a_legacy_leading_dash_uid_via_double_dash(
        run, pkm_client):
    # Same argparse hazard as `pkm get`: a uid starting with '-' must be
    # addressed with `--` to end option parsing.
    legacy_uid = "-legacy1a2b3c"
    pkm_client.post_ops([
        {"op": "create", "uid": legacy_uid, "page_title": "AI",
         "parent_uid": None, "order_idx": 52, "text": "legacy dash block"},
    ], batch_id="legacy-dash-update")
    code, out, _ = run("update", "--", legacy_uid, "rewritten legacy block")
    assert code == 0
    assert out == f"updated ^{legacy_uid}\n"
    assert pkm_client.get_block(legacy_uid).block.text == \
        "rewritten legacy block"


def test_update_done_flag_on_a_legacy_leading_dash_uid_puts_flags_before_the_guard(
        run, pkm_client):
    # -D/-T must come before `--` since everything after it is positional.
    legacy_uid = "-legacy4d5e6f"
    pkm_client.post_ops([
        {"op": "create", "uid": legacy_uid, "page_title": "AI",
         "parent_uid": None, "order_idx": 53, "text": "{{TODO}} legacy task"},
    ], batch_id="legacy-dash-update-done")
    code, _, _ = run("update", "-D", "--", legacy_uid)
    assert code == 0
    assert pkm_client.get_block(legacy_uid).block.text == \
        "{{DONE}} legacy task"


def test_batch_reports_a_move_that_would_make_a_cycle_and_exits_1(
        run, pkm_client):
    # Moving a block under its own child is skipped, not a 400
    from datetime import date
    today = title_for_date(date.today())
    cmds = [
        {"command": "move", "params": {"uid": "uid_b2",
                                       "page": "Machine Learning",
                                       "parent": "((uid_b3))"}},
        {"command": "create", "params": {"page": "AI", "text": "kept"}},
    ]
    code, out, err = run("batch", stdin=json.dumps(cmds))
    assert code == 1
    assert out.splitlines()[:2] == [
        "warning: skipped 1 of 2 ops; the other 1 was applied",
        "  move ^uid_b2: target is the block itself or one of its"
        f" descendants; noted on [[{today}]]"]
    assert "do not re-run the batch" in err
    assert "kept" in _page_texts(pkm_client, "AI")


def test_batch_reports_ops_skipped_for_a_missing_uid_and_exits_1(
        run, pkm_client):
    # batch update/move/delete send the uid unchecked; a mistyped one is
    # skipped server-side (never a 400), so the ack's `skipped` list is
    # the only signal -- it must not read as a clean success
    from datetime import date
    today = title_for_date(date.today())
    cmds = [
        {"command": "update", "params": {"uid": "uid_typo99",
                                         "text": "meant for b3"}},
        {"command": "delete", "params": {"uid": "uid_typo98"}},
        {"command": "create", "params": {"page": "AI", "text": "kept"}},
    ]
    code, out, err = run("batch", stdin=json.dumps(cmds))
    assert code == 1
    assert out == (
        "warning: skipped 3 of 4 ops; the other 1 was applied\n"
        f"  update_text ^uid_typo99: block not found; noted on [[{today}]]\n"
        f"  set_heading ^uid_typo99: block not found; noted on [[{today}]]\n"
        "  delete ^uid_typo98: block not found; nothing written\n"
        "the batch is committed: fix the skipped ops on their own, do not re-run it\n")
    assert "do not re-run the batch" in err
    assert "kept" in _page_texts(pkm_client, "AI")


def _seed_root_with_child(pkm_client, batch_id):
    pkm_client.post_ops([
        {"op": "create", "uid": "gdroot0001", "page_title": "AI",
         "parent_uid": None, "order_idx": 60, "text": "doomed root"},
        {"op": "create", "uid": "gdchild001", "page_title": "AI",
         "parent_uid": "gdroot0001", "order_idx": 0, "text": "server child"},
    ], batch_id=batch_id)


def _today_texts(pkm_client):
    from datetime import date
    try:
        return _page_texts(pkm_client, title_for_date(date.today()))
    except ApiError as e:
        assert e.status == 404
        return []


def test_batch_delete_matching_subtree_lands_no_copy(run, pkm_client):
    _seed_root_with_child(pkm_client, "gd-seed-match")
    code, out, _ = run("batch", stdin=json.dumps(
        [{"command": "delete", "params": {"uid": "gdroot0001"}}]))
    assert code == 0
    assert out == "applied 1 ops\n"
    assert "doomed root" not in _page_texts(pkm_client, "AI")
    assert not any("[[conflict]]" in t for t in _today_texts(pkm_client))


def test_batch_delete_stale_fetch_lands_the_copy(
        run, pkm_client, monkeypatch):
    # The fetch saw an older child text than the server now holds: the
    # delete still applies, and the server's texts are kept under the
    # conflict header on today's daily page. A lone `delete` names no
    # page, so `apply_batch` learns "AI" from `get_block` and then hashes
    # the subtree from `get_page_blocks("AI")` (see `_delete_subtrees`);
    # both are staled here so the hash reflects the same older snapshot
    # regardless of which one the resolution path lands on.
    _seed_root_with_child(pkm_client, "gd-seed-stale")
    real_get_block = pkm_client.get_block
    real_get_page_blocks = pkm_client.get_page_blocks

    def _stale_children(children):
        return [c.model_copy(update={"text": "what the fetch saw"})
                for c in children]

    def _stale_get_block(uid):
        payload = real_get_block(uid)
        block = payload.block
        return payload.model_copy(update={"block": block.model_copy(
            update={"children": _stale_children(block.children)})})

    def _stale_get_page_blocks(title):
        blocks, missing = real_get_page_blocks(title)
        if title != "AI":
            return blocks, missing
        staled = [b.model_copy(update={"children": _stale_children(b.children)})
                 if b.uid == "gdroot0001" else b for b in blocks]
        return staled, missing

    monkeypatch.setattr(pkm_client, "get_block", _stale_get_block)
    monkeypatch.setattr(pkm_client, "get_page_blocks", _stale_get_page_blocks)
    code, _, _ = run("batch", stdin=json.dumps(
        [{"command": "delete", "params": {"uid": "gdroot0001"}}]))
    assert code == 0
    assert "doomed root" not in _page_texts(pkm_client, "AI")
    from datetime import date
    today = pkm_client.get_page(title_for_date(date.today()))
    [header] = [n for n in today.blocks if n.text ==
                "[[conflict]] [[AI]] — deleted while edited elsewhere"]
    [root_copy] = header.children
    assert root_copy.text == "doomed root"
    assert [c.text for c in root_copy.children] == ["server child"]


def test_batch_delete_of_a_missing_uid_still_reports_skipped(run, pkm_client):
    code, out, err = run("batch", stdin=json.dumps(
        [{"command": "delete", "params": {"uid": "gdmissing1"}}]))
    assert code == 1
    assert out.splitlines()[:2] == [
        "warning: skipped 1 of 1 ops; nothing else was applied",
        "  delete ^gdmissing1: block not found; nothing written"]
    assert "do not re-run the batch" in err


def test_batch_delete_fetch_failure_fails_the_batch(
        run, pkm_client, monkeypatch):
    # Only a 404 means "no such block"; any other fetch failure must not
    # quietly send the delete unguarded.
    _seed_root_with_child(pkm_client, "gd-seed-fail")

    def _broken_get_block(uid):
        raise ApiError(503, "unavailable")

    monkeypatch.setattr(pkm_client, "get_block", _broken_get_block)
    code, out, err = run("batch", stdin=json.dumps(
        [{"command": "delete", "params": {"uid": "gdroot0001"}}]))
    assert code == 1
    assert out == ""
    assert "503" in err
    assert "doomed root" in _page_texts(pkm_client, "AI")
