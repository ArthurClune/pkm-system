import json
from pathlib import Path

from pkm.server.config import load_config


def write_config(tmp_path: Path, extra: dict) -> Path:
    raw = {"db_file": "pkm.sqlite3", "assets_dir": "assets",
           "password_salt": "ab", "password_hash": "cd",
           "session_secret": "ef", **extra}
    p = tmp_path / "config.json"
    p.write_text(json.dumps(raw), encoding="utf-8")
    return p


def test_bind_and_upload_defaults(tmp_path):
    c = load_config(write_config(tmp_path, {}))
    assert c.bind_hosts == ("127.0.0.1",)
    assert c.max_upload_bytes == 150 * 1024 * 1024


def test_bind_and_upload_explicit(tmp_path):
    c = load_config(write_config(tmp_path, {
        "bind_hosts": ["127.0.0.1", "100.104.1.2"],
        "max_upload_bytes": 1024,
    }))
    assert c.bind_hosts == ("127.0.0.1", "100.104.1.2")
    assert c.max_upload_bytes == 1024
