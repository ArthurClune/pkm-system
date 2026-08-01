import io
import json

import pytest

from pkm.cli.main import main
from pkm.client.core import ApiError
from pkm.server.daily import title_for_date


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
            yield n["text"]
            yield from _flat(n["children"])
    return list(_flat(pkm_client.get_page(title)["blocks"]))


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
    heading = next(n for n in page["blocks"] if n["text"] == "Notes")
    assert heading["heading"] == 2
    assert heading["children"][0]["text"] == "beneath"


def test_save_twice_to_a_control_whitespace_titled_page_appends_and_reuses_the_heading(
        run, pkm_client):
    """A page title holding control whitespace (e.g. a stray tab) is
    normalized at creation (pkm-hjhy) -- "Ctrl\tTitle" is only ever stored,
    and addressable, as "Ctrl Title". A second `pkm save` to the SAME raw
    (pre-normalization) title must see the page's real, already-saved
    blocks -- not a false-empty placeholder that would reset the append
    position to the top of the page and mint a second "## Notes" heading
    the first save already created (pkm-5k8p)."""
    run("save", "-p", "Ctrl\tTitle", "--parent", "## Notes", "first")
    code, _, _ = run("save", "-p", "Ctrl\tTitle", "--parent", "## Notes", "second")
    assert code == 0
    page = pkm_client.get_page("Ctrl Title")
    headings = [n for n in page["blocks"] if n["text"] == "Notes"]
    assert len(headings) == 1
    assert [c["text"] for c in headings[0]["children"]] == ["first", "second"]


def test_update_text(run, pkm_client):
    code, out, _ = run("update", "uid_b6", "rewritten")
    assert code == 0
    assert out == "updated ^uid_b6\n"
    assert pkm_client.get_block("uid_b6")["block"]["text"] == "rewritten"


def test_update_done_and_todo_flags(run, pkm_client):
    run("save", "-p", "AI", "--todo", "task x")
    uid = pkm_client.todos(page="AI")["groups"][0]["items"][0]["uid"]
    run("update", uid, "-D")
    assert pkm_client.get_block(uid)["block"]["text"] == "{{DONE}} task x"
    run("update", uid, "-T")
    assert pkm_client.get_block(uid)["block"]["text"] == "{{TODO}} task x"


def test_update_stdin_strips_trailing_newline(run, pkm_client):
    code, _, _ = run("update", "uid_b6", "-", stdin="rewritten\n")
    assert code == 0
    assert pkm_client.get_block("uid_b6")["block"]["text"] == "rewritten"


def test_update_stdin_strips_multiple_trailing_newlines_only(run, pkm_client):
    code, _, _ = run("update", "uid_b6", "-", stdin="rewritten  \n\n")
    assert code == 0
    assert pkm_client.get_block("uid_b6")["block"]["text"] == "rewritten  "


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
    assert pkm_client.search_assets("pic.png")["total"] == 0


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
    assert pkm_client.search_assets("pic.png")["total"] == 0
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
    assert pkm_client.search_assets("pic.png")["total"] == 1


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
    mtg = next(n for n in page["blocks"] if n["text"] == "[[Meeting]] notes")
    assert [c["text"] for c in mtg["children"]] == ["Attendees", "Actions"]


def test_save_empty_text_on_new_page_leaves_no_page_behind(run, pkm_client):
    # plan_save rejects empty text after the page would already have been
    # fetched/created -- the page must not persist when the save as a
    # whole fails (pkm-w80k: page creation rides the same atomic batch).
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


def test_batch_schema_failure_leaves_no_page_or_blocks(run, pkm_client):
    # A schema-invalid second command must fail the whole batch before the
    # first command's brand-new page is fetched/created at all (pkm-4w23:
    # validation runs before any page discovery or I/O).
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
    overview = next(n for n in page["blocks"] if n["text"] == "Overview")
    assert overview["heading"] == 2
    assert overview["children"][0]["text"] == "detail"


def test_update_to_a_heading_sets_the_level(run, pkm_client):
    code, _, _ = run("update", "uid_b6", "## Rewritten")
    assert code == 0
    block = pkm_client.get_block("uid_b6")["block"]
    assert (block["text"], block["heading"]) == ("Rewritten", 2)


def test_update_to_plain_text_clears_the_level(run, pkm_client):
    run("update", "uid_b6", "## Rewritten")
    run("update", "uid_b6", "Rewritten again")
    block = pkm_client.get_block("uid_b6")["block"]
    assert (block["text"], block["heading"]) == ("Rewritten again", None)


def test_update_done_flag_keeps_the_heading(run, pkm_client):
    run("update", "uid_b6", "## Task x")
    run("update", "uid_b6", "-D")
    block = pkm_client.get_block("uid_b6")["block"]
    assert (block["text"], block["heading"]) == ("{{DONE}} Task x", 2)


def test_update_addresses_a_legacy_leading_dash_uid_via_double_dash(
        run, pkm_client):
    # Same argparse hazard as `pkm get`: a uid starting with '-' must be
    # addressed with `--` to end option parsing (pkm-y5yv).
    legacy_uid = "-legacy1a2b3c"
    pkm_client.post_ops([
        {"op": "create", "uid": legacy_uid, "page_title": "AI",
         "parent_uid": None, "order_idx": 52, "text": "legacy dash block"},
    ], batch_id="legacy-dash-update")
    code, out, _ = run("update", "--", legacy_uid, "rewritten legacy block")
    assert code == 0
    assert out == f"updated ^{legacy_uid}\n"
    assert pkm_client.get_block(legacy_uid)["block"]["text"] == \
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
    assert pkm_client.get_block(legacy_uid)["block"]["text"] == \
        "{{DONE}} legacy task"
