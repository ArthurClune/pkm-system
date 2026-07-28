"""Routes: /api/assets/describe-status, /api/assets/scan, /api/assets/search,
plus the upload → enqueue hook."""
import time

from fake_describer import PNG

from pkm.describe.openai_client import OpenAIDescriber

_NO_KEY_REASON = ("OPENAI_API_KEY is not set and no openai_key file in the "
                  "data directory")


def _upload(client, content=PNG, name="graph.png", mime="image/png"):
    r = client.post("/api/assets", files={"file": (name, content, mime)})
    assert r.status_code == 200
    return r.json()["sha256"]


def _wait_processed(client, sha, tries=250):
    """The worker runs on the app loop in TestClient's portal thread, so it
    makes progress while this thread sleeps; poll until the row leaves
    'pending' (described or failed)."""
    for _ in range(tries):
        hits = client.get("/api/assets/search", params={"q": ""}).json()["assets"]
        row = next(h for h in hits if h["sha256"] == sha)
        if row["status"] != "pending":
            return row
        time.sleep(0.02)
    raise AssertionError(f"asset {sha[:12]} still pending after wait")


def test_describe_status_enabled(describe_client):
    r = describe_client.get("/api/assets/describe-status")
    assert r.status_code == 200
    assert r.json() == {"enabled": True, "reason": None}


def test_describe_status_disabled(describe_disabled_client):
    r = describe_disabled_client.get("/api/assets/describe-status")
    assert r.json() == {"enabled": False, "reason": _NO_KEY_REASON}


def test_upload_triggers_description(describe_client):
    sha = _upload(describe_client)
    row = _wait_processed(describe_client, sha)
    assert row["status"] == "described"
    hits = describe_client.get("/api/assets/search",
                               params={"q": "revenue"}).json()["assets"]
    assert [h["sha256"] for h in hits] == [sha]
    assert hits[0]["description"] == "a bar chart of monthly revenue"
    assert hits[0]["url"] == f"/assets/{sha}/graph.png"


def test_upload_when_disabled_still_succeeds(describe_disabled_client):
    sha = _upload(describe_disabled_client)
    r = describe_disabled_client.get("/api/assets/search", params={"q": ""})
    hits = r.json()["assets"]
    assert hits[0]["sha256"] == sha
    assert hits[0]["status"] == "pending"


def test_scan_endpoint(describe_client):
    sha = _upload(describe_client)        # described on upload
    _wait_processed(describe_client, sha)
    r = describe_client.post("/api/assets/scan")
    assert r.json() == {"queued": 0, "enabled": True, "reason": None}
    # force re-queues nothing here either: described rows are never rescanned
    r = describe_client.post("/api/assets/scan", params={"force": "true"})
    assert r.json()["queued"] == 0


def test_scan_disabled(describe_disabled_client):
    r = describe_disabled_client.post("/api/assets/scan")
    assert r.json() == {"queued": 0, "enabled": False, "reason": _NO_KEY_REASON}


def test_search_by_filename_and_recency(describe_client):
    sha_a = _upload(describe_client, content=PNG + b"a", name="alpha.png")
    sha_b = _upload(describe_client, content=PNG + b"b", name="beta.png")
    _wait_processed(describe_client, sha_b)
    hits = describe_client.get("/api/assets/search",
                               params={"q": "beta"}).json()["assets"]
    assert [h["sha256"] for h in hits] == [sha_b]
    both = describe_client.get("/api/assets/search",
                               params={"q": ""}).json()["assets"]
    assert {h["sha256"] for h in both} == {sha_a, sha_b}


def test_search_like_escaping(describe_client):
    _upload(describe_client, name="100%.png")
    hits = describe_client.get("/api/assets/search",
                               params={"q": "0%"}).json()["assets"]
    assert len(hits) == 1              # % matched literally, not as wildcard
    none = describe_client.get("/api/assets/search",
                               params={"q": "zzz%"}).json()["assets"]
    assert none == []


def test_default_service_disabled_without_key(seeded_config):
    from pkm.server.app import _default_describe_service
    service = _default_describe_service(seeded_config)
    assert service.enabled is False
    assert service.reason == _NO_KEY_REASON


def test_default_service_disabled_with_empty_key_file(seeded_config):
    from pkm.server.app import _default_describe_service
    seeded_config.openai_api_key_file.write_text("", encoding="utf-8")
    service = _default_describe_service(seeded_config)
    assert service.enabled is False
    assert service.reason == _NO_KEY_REASON


def test_default_service_disabled_with_undecodable_key_file(seeded_config):
    """A key file that isn't valid UTF-8 must degrade to disabled, not raise
    UnicodeDecodeError out of the app factory (pkm-wwy3 review fix)."""
    from pkm.server.app import _default_describe_service
    seeded_config.openai_api_key_file.write_bytes(b"\xff\xfe\x00")
    service = _default_describe_service(seeded_config)
    assert service.enabled is False
    assert service.reason == _NO_KEY_REASON


def test_default_service_enabled_with_key(seeded_config, monkeypatch):
    from pkm.server.app import _default_describe_service
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    service = _default_describe_service(seeded_config)
    assert service.enabled is True
    assert service.reason is None


def test_default_service_enabled_with_key_file(seeded_config):
    """No env var, but the configured key-file path has stripped content:
    the feature comes up using the file's key (pkm-wwy3)."""
    from pkm.server.app import _default_describe_service
    seeded_config.openai_api_key_file.write_text("sk-file-test\n", encoding="utf-8")
    service = _default_describe_service(seeded_config)
    assert service.enabled is True
    assert service.reason is None
    assert isinstance(service._describer, OpenAIDescriber)
    assert service._describer._headers["Authorization"] == "Bearer sk-file-test"


def test_default_service_uses_config_json_key_file_override(tmp_path):
    """config.json's openai_api_key_file (resolved relative to config.json,
    like db_file/assets_dir) points at a custom relative path."""
    import json

    from pkm.server.app import _default_describe_service
    from pkm.server.config import load_config

    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "db_file": "pkm.sqlite3", "assets_dir": "assets",
        "password_salt": "ab", "password_hash": "cd",
        "session_secret": "ef",
        "openai_api_key_file": "secrets/my-key",
    }), encoding="utf-8")
    key_file = tmp_path / "secrets" / "my-key"
    key_file.parent.mkdir()
    key_file.write_text("sk-custom-test\n", encoding="utf-8")

    config = load_config(cfg_path)
    assert config.openai_api_key_file == key_file

    service = _default_describe_service(config)
    assert service.enabled is True
    assert isinstance(service._describer, OpenAIDescriber)
    assert service._describer._headers["Authorization"] == "Bearer sk-custom-test"
