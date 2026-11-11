import inspect
import json
from dataclasses import MISSING, fields
from pathlib import Path

import pytest

from pkm.server.config import Config, load_config


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


def test_serve_origins_default_empty(tmp_path):
    assert load_config(write_config(tmp_path, {})).serve_origins == ()


def test_serve_origins_normalised(tmp_path):
    c = load_config(write_config(tmp_path, {
        "serve_origins": ["HTTPS://Biber.bobtail-dorian.ts.net/"]}))
    assert c.serve_origins == ("https://biber.bobtail-dorian.ts.net",)


def test_serve_origins_refuses_a_bare_hostname(tmp_path):
    p = write_config(tmp_path, {
        "serve_origins": ["biber.bobtail-dorian.ts.net"]})
    with pytest.raises(ValueError) as exc:
        load_config(p)
    assert "serve_origins" in str(exc.value)
    assert "biber.bobtail-dorian.ts.net" in str(exc.value)


def test_serve_origins_refuses_a_string(tmp_path):
    p = write_config(tmp_path, {"serve_origins": "https://h.example"})
    with pytest.raises(ValueError, match="serve_origins"):
        load_config(p)


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


def test_local_docs_root_default_is_none(tmp_path):
    cfg = load_config(write_config(tmp_path, {}))
    assert cfg.local_docs_root is None


def test_local_docs_root_relative_resolves_against_config_dir(tmp_path):
    cfg = load_config(write_config(tmp_path, {"local_docs_root": "docs"}))
    assert cfg.local_docs_root == tmp_path / "docs"


def test_local_docs_root_absolute_passes_through(tmp_path):
    cfg = load_config(write_config(
        tmp_path, {"local_docs_root": "/Volumes/Papers/pkm"}))
    assert cfg.local_docs_root == Path("/Volumes/Papers/pkm")


def test_goodlinks_defaults(tmp_path):
    cfg = load_config(write_config(tmp_path, {}))
    assert cfg.goodlinks_api_key_file == tmp_path / "../goodlinks_key"
    assert cfg.goodlinks_api_url == "http://localhost:9428/api/v1"


def test_an_empty_config_resolves_to_these_values(tmp_path):
    assert load_config(write_config(tmp_path, {})) == Config(
        db_path=tmp_path / "pkm.sqlite3",
        assets_dir=tmp_path / "assets",
        password_salt="ab",
        password_hash="cd",
        session_secret="ef",
        cookie_secure=True,
        web_dist=None,
        bind_hosts=("127.0.0.1",),
        serve_origins=(),
        max_upload_bytes=150 * 1024 * 1024,
        image_descriptions=True,
        image_description_model="gpt-4o-mini",
        openai_api_key_file=tmp_path / "../openai_key",
        zai_api_key_file=tmp_path / "../zai_key",
        local_docs_root=None,
        goodlinks_api_key_file=tmp_path / "../goodlinks_key",
        goodlinks_api_url="http://localhost:9428/api/v1",
    )


def test_an_empty_config_gets_every_dataclass_default(tmp_path):
    cfg = load_config(write_config(tmp_path, {}))
    for field in fields(Config):
        if field.default is MISSING:
            continue
        want = (tmp_path / field.default if isinstance(field.default, Path)
                else field.default)
        assert getattr(cfg, field.name) == want, field.name


def test_key_files_resolve_beside_the_config_not_the_cwd(
        tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    data = tmp_path / "home" / "data"
    data.mkdir(parents=True)
    cfg = load_config(write_config(data, {}))
    for name in ("openai_api_key_file", "zai_api_key_file",
                 "goodlinks_api_key_file"):
        assert getattr(cfg, name).parent == data / "..", name


@pytest.mark.parametrize("empty", ["", None])
def test_an_empty_path_key_means_none(tmp_path, empty):
    cfg = load_config(write_config(
        tmp_path, {"web_dist": empty, "local_docs_root": empty}))
    assert cfg.web_dist is None
    assert cfg.local_docs_root is None


def test_every_optional_key_is_converted(tmp_path):
    cfg = load_config(write_config(tmp_path, {
        "cookie_secure": False,
        "web_dist": "dist",
        "bind_hosts": ["127.0.0.1", "100.1.2.3"],
        "serve_origins": ["https://h.example/"],
        "max_upload_bytes": "1024",
        "image_descriptions": 0,
        "image_description_model": "m",
        "openai_api_key_file": "o",
        "zai_api_key_file": "z",
        "local_docs_root": "docs",
        "goodlinks_api_key_file": "g",
        "goodlinks_api_url": "http://127.0.0.1:1/api",
    }))
    assert cfg == Config(
        db_path=tmp_path / "pkm.sqlite3",
        assets_dir=tmp_path / "assets",
        password_salt="ab",
        password_hash="cd",
        session_secret="ef",
        cookie_secure=False,
        web_dist=tmp_path / "dist",
        bind_hosts=("127.0.0.1", "100.1.2.3"),
        serve_origins=("https://h.example",),
        max_upload_bytes=1024,
        image_descriptions=False,
        image_description_model="m",
        openai_api_key_file=tmp_path / "o",
        zai_api_key_file=tmp_path / "z",
        local_docs_root=tmp_path / "docs",
        goodlinks_api_key_file=tmp_path / "g",
        goodlinks_api_url="http://127.0.0.1:1/api",
    )
    assert isinstance(cfg.bind_hosts, tuple)


def test_load_config_restates_no_default():
    source = inspect.getsource(load_config)
    for literal in ('"gpt-4o-mini"', '"../openai_key"', '"../zai_key"',
                    '"../goodlinks_key"', '"http://localhost:9428/api/v1"',
                    '"127.0.0.1"', "150 * 1024 * 1024"):
        assert literal not in source, literal


def test_goodlinks_keys_are_read(tmp_path):
    cfg = load_config(write_config(tmp_path, {
        "goodlinks_api_key_file": "secrets/gl",
        "goodlinks_api_url": "http://127.0.0.1:9429/api/v1",
    }))
    assert cfg.goodlinks_api_key_file == tmp_path / "secrets/gl"
    assert cfg.goodlinks_api_url == "http://127.0.0.1:9429/api/v1"
