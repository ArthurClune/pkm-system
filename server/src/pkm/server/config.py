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
    )
