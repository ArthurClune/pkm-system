import os

import pytest

from pkm.client import api as client_api
from pkm.client.api import PkmClient, login, new_uid
from pkm.client.core import ApiError, CliConfig, ConfigError
from pkm.server.ops_core import UID_RE


def test_new_uid_matches_server_uid_re():
    uids = {new_uid() for _ in range(50)}
    assert len(uids) == 50
    assert all(UID_RE.fullmatch(u) for u in uids)


def test_config_path_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("PKM_CLI_CONFIG", str(tmp_path / "c.json"))
    assert client_api.config_path() == tmp_path / "c.json"


def test_save_and_load_config(monkeypatch, tmp_path):
    monkeypatch.setenv("PKM_CLI_CONFIG", str(tmp_path / "c.json"))
    monkeypatch.delenv("PKM_URL", raising=False)
    cfg = CliConfig(url="http://x:1", token="t")
    client_api.save_config(cfg)
    assert (tmp_path / "c.json").stat().st_mode & 0o777 == 0o600
    assert client_api.load_config() == cfg


def test_save_config_creates_via_atomic_exclusive_tempfile(monkeypatch, tmp_path):
    monkeypatch.setenv("PKM_CLI_CONFIG", str(tmp_path / "c.json"))
    monkeypatch.delenv("PKM_URL", raising=False)
    opens: list[tuple[str, int, int]] = []
    real_open = os.open

    def spy_open(path, flags, mode=0o777):
        opens.append((str(path), flags, mode))
        return real_open(path, flags, mode)

    monkeypatch.setattr(client_api.os, "open", spy_open)
    cfg = CliConfig(url="http://x:1", token="t")
    client_api.save_config(cfg)

    assert len(opens) == 1
    path, flags, mode = opens[0]
    assert flags & os.O_EXCL
    assert flags & os.O_CREAT
    assert mode == 0o600
    assert path != str(tmp_path / "c.json")  # written via a temp file, not in place
    assert [p.name for p in tmp_path.iterdir()] == ["c.json"]  # no leftover temp file
    assert (tmp_path / "c.json").stat().st_mode & 0o777 == 0o600
    assert client_api.load_config() == cfg


def test_load_config_missing_file_hints_login(monkeypatch, tmp_path):
    monkeypatch.setenv("PKM_CLI_CONFIG", str(tmp_path / "absent.json"))
    with pytest.raises(ConfigError, match="pkm login"):
        client_api.load_config()


def test_load_config_pkm_url_override(monkeypatch, tmp_path):
    monkeypatch.setenv("PKM_CLI_CONFIG", str(tmp_path / "c.json"))
    client_api.save_config(CliConfig(url="http://x:1", token="t"))
    monkeypatch.setenv("PKM_URL", "http://other:2/")
    assert client_api.load_config().url == "http://other:2"


def test_login_returns_token(anon_client):
    token = login("http://testserver", "test-pw", http=anon_client)
    assert token.startswith("v1.")


def test_login_wrong_password_raises(anon_client):
    with pytest.raises(ApiError) as e:
        login("http://testserver", "wrong", http=anon_client)
    assert e.value.status == 401


def test_get_page_and_block(pkm_client):
    page = pkm_client.get_page("Machine Learning")
    assert page["page"]["title"] == "Machine Learning"
    block = pkm_client.get_block("uid_b3")
    assert block["breadcrumbs"] == ["Papers"]


def test_get_page_quotes_title(pkm_client):
    # daily titles contain a comma+space; slash titles pass through the
    # {title:path} converter unencoded
    page = pkm_client.get_page("July 7th, 2026")
    assert page["page"]["title"] == "July 7th, 2026"


def test_search_query_todos(pkm_client):
    assert pkm_client.search("Papers")["blocks"]
    assert pkm_client.run_query("{and: [[Paper]]}")["total"] == 1
    assert pkm_client.todos() == {"groups": [], "total": 0}


def test_post_ops_creates_block(pkm_client):
    uid = new_uid()
    r = pkm_client.post_ops([{"op": "create", "uid": uid,
                              "page_title": "AI", "parent_uid": None,
                              "order_idx": 1, "text": "from client"}])
    assert r["applied"] == 1
    assert pkm_client.get_block(uid)["block"]["text"] == "from client"


def test_post_ops_rejects_malformed_op_locally(pkm_client):
    with pytest.raises(ApiError) as e:
        pkm_client.post_ops([{"op": "create", "uid": "x!"}])  # missing fields
    assert e.value.status == 422


def test_api_error_carries_friendly_message(pkm_client):
    with pytest.raises(ApiError) as e:
        pkm_client.get_page("No Such Page")
    assert e.value.status == 404


def test_upload_asset(pkm_client, tmp_path):
    p = tmp_path / "note.txt"
    p.write_bytes(b"hello")
    r = pkm_client.upload(p)
    assert r["url"].startswith("/assets/")
    assert r["filename"] == "note.txt"


def test_unauthenticated_client_gets_login_hint(anon_client):
    bad = PkmClient(CliConfig(url="http://testserver", token="junk"),
                    http=anon_client)
    with pytest.raises(ApiError, match="pkm login"):
        bad.get_page("AI")
