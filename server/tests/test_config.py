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


def test_image_description_defaults(tmp_path):
    cfg = load_config(write_config(tmp_path, {}))
    assert cfg.image_descriptions is True
    assert cfg.image_description_model == "gpt-4o-mini"


def test_image_description_overrides(tmp_path):
    cfg = load_config(write_config(tmp_path, {"image_descriptions": False,
                                               "image_description_model": "gpt-5-mini"}))
    assert cfg.image_descriptions is False
    assert cfg.image_description_model == "gpt-5-mini"


def test_openai_api_key_file_default(tmp_path):
    cfg = load_config(write_config(tmp_path, {}))
    # Default lives one level above the data dir (PKM_HOME root), never
    # inside it: this is a pure path assertion, no file is created here.
    assert cfg.openai_api_key_file == tmp_path / "../openai_key"


def test_openai_api_key_file_override(tmp_path):
    cfg = load_config(write_config(
        tmp_path, {"openai_api_key_file": "secrets/my-key"}))
    assert cfg.openai_api_key_file == tmp_path / "secrets" / "my-key"


def test_zai_api_key_file_default(tmp_path):
    cfg = load_config(write_config(tmp_path, {}))
    # Same placement rule as the OpenAI key: PKM_HOME root, never the
    # data dir. Pure path assertion, no file is created here.
    assert cfg.zai_api_key_file == tmp_path / "../zai_key"


def test_zai_api_key_file_override(tmp_path):
    cfg = load_config(write_config(
        tmp_path, {"zai_api_key_file": "secrets/glm-key"}))
    assert cfg.zai_api_key_file == tmp_path / "secrets" / "glm-key"
