# pattern: Imperative Shell
"""Server configuration loaded from data/config.json (never in git)."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    db_path: Path
    assets_dir: Path
    password_salt: str   # hex
    password_hash: str   # hex (scrypt)
    session_secret: str  # hex
    cookie_secure: bool = True
    web_dist: Path | None = None  # built SPA dir; None = API-only server
    bind_hosts: tuple[str, ...] = ("127.0.0.1",)
    max_upload_bytes: int = 150 * 1024 * 1024
    image_descriptions: bool = True
    image_description_model: str = "gpt-4o-mini"
    # Where the OpenAI key lives on disk (mode 600, never committed) so the
    # feature can be enabled without launchd plist surgery. Default is one
    # level above the data dir (PKM_HOME root, resolved relative to
    # config.json's parent): the data dir holds servable/exportable content
    # (assets, DB), and the key shouldn't sit somewhere a future
    # export/browse feature might sweep it up. The key file wins over the
    # OPENAI_API_KEY env var when both are present (see
    # server/_default_describe_service).
    openai_api_key_file: Path = Path("../openai_key")


def load_config(path: Path) -> Config:
    raw = json.loads(path.read_text(encoding="utf-8"))
    base = path.parent
    return Config(
        db_path=base / raw["db_file"],
        assets_dir=base / raw["assets_dir"],
        password_salt=raw["password_salt"],
        password_hash=raw["password_hash"],
        session_secret=raw["session_secret"],
        cookie_secure=raw.get("cookie_secure", True),
        web_dist=(base / raw["web_dist"]) if raw.get("web_dist") else None,
        bind_hosts=tuple(raw.get("bind_hosts", ["127.0.0.1"])),
        max_upload_bytes=int(raw.get("max_upload_bytes", 150 * 1024 * 1024)),
        image_descriptions=bool(raw.get("image_descriptions", True)),
        image_description_model=str(raw.get("image_description_model",
                                            "gpt-4o-mini")),
        openai_api_key_file=base / raw.get("openai_api_key_file", "../openai_key"),
    )
