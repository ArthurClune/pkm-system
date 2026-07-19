import json

import pytest

from pkm.cli.main import main
from pkm.server.daily import title_for_date


@pytest.fixture()
def run(pkm_client, capsys):
    def _run(*argv: str) -> tuple[int, str, str]:
        code = main(list(argv), make_client=lambda: pkm_client)
        out, err = capsys.readouterr()
        return code, out, err
    return _run


def test_get_page_markdown(run):
    code, out, _ = run("get", "Machine Learning")
    assert code == 0
    assert out.startswith("# Machine Learning\n")
    assert "- ## Papers" in out


def test_get_page_json(run):
    code, out, _ = run("get", "Machine Learning", "--json")
    assert json.loads(out)["page"]["title"] == "Machine Learning"


def test_get_uids_flag(run):
    _, out, _ = run("get", "Machine Learning", "--uids")
    assert "^uid_b1" in out


def test_get_today_creates_and_renders_daily(run):
    code, out, _ = run("get", "today")
    assert code == 0
    from datetime import date
    assert out.startswith(f"# {title_for_date(date.today())}\n")


def test_get_block_by_uid(run):
    code, out, _ = run("get", "uid_b3")
    assert code == 0
    assert out.startswith("(in: Machine Learning > Papers)")


def test_get_uid_shaped_page_title_falls_back(run, pkm_client):
    pkm_client.create_page("uidlike")
    code, out, _ = run("get", "uidlike")
    assert code == 0
    assert out.startswith("# uidlike\n")


def test_get_missing_page_exits_1_with_stderr(run):
    code, out, err = run("get", "No Such Page")
    assert code == 1
    assert out == ""
    assert "404" in err


def test_search(run):
    code, out, _ = run("search", "Papers")
    assert code == 0
    assert "## Blocks" in out


def test_refs(run):
    code, out, _ = run("refs", "Machine Learning")
    assert code == 0
    assert out.startswith("# Backlinks: Machine Learning (1 pages)")
    assert "July 7th, 2026" in out


def test_query(run):
    code, out, _ = run("query", "{and: [[Paper]]}")
    assert code == 0
    assert "^uid_b3" in out
    assert "(1 total)" in out


def test_query_parse_error_exits_1(run):
    code, _, err = run("query", "{nope: [[X]]}")
    assert code == 1
    assert "unsupported clause" in err


def test_todos_empty(run):
    code, out, _ = run("todos")
    assert code == 0
    assert "(0 total)" in out


def test_login_writes_config(monkeypatch, tmp_path, anon_client, capsys):
    import pkm.cli.main as cli_main
    monkeypatch.setenv("PKM_CLI_CONFIG", str(tmp_path / "c.json"))
    monkeypatch.setattr(cli_main, "_login_http", lambda url: anon_client)
    monkeypatch.setattr("getpass.getpass", lambda prompt: "test-pw")
    code = main(["login", "--url", "http://testserver"])
    assert code == 0
    saved = json.loads((tmp_path / "c.json").read_text())
    assert saved["url"] == "http://testserver"
    assert saved["token"].startswith("v1.")
    assert "logged in" in capsys.readouterr().out


def test_login_password_stdin(monkeypatch, tmp_path, anon_client, capsys):
    import io
    import pkm.cli.main as cli_main
    monkeypatch.setenv("PKM_CLI_CONFIG", str(tmp_path / "c.json"))
    monkeypatch.setattr(cli_main, "_login_http", lambda url: anon_client)
    monkeypatch.setattr("sys.stdin", io.StringIO("test-pw\n"))
    assert main(["login", "--url", "http://testserver",
                 "--password-stdin"]) == 0


def test_no_config_error_is_friendly(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("PKM_CLI_CONFIG", str(tmp_path / "absent.json"))
    code = main(["get", "X"])
    assert code == 1
    assert "pkm login" in capsys.readouterr().err
