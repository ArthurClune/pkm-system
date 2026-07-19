import io
import json

import pytest

from pkm.cli.main import main
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


def test_batch_bad_json_exits_1(run):
    code, _, err = run("batch", stdin="not json")
    assert code == 1
    assert "JSON" in err


def test_batch_unknown_command_exits_1(run):
    code, _, err = run("batch", stdin=json.dumps(
        [{"command": "zap", "params": {}}]))
    assert code == 1
    assert "unknown command" in err
