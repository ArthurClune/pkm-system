# pattern: Imperative Shell
"""Boot a throwaway server for the Playwright smoke: fresh empty DB in a
temp dir, fixed password "e2e-pw", serves the built SPA from web/dist.
Run: uv run python tests/e2e_serve.py   (from server/)"""
from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

import uvicorn

from pkm.schema import DDL
from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import init_db

PORT = 8975
PASSWORD = "e2e-pw"
SALT = bytes.fromhex("11" * 16)


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    web_dist = root / "web" / "dist"
    assert (web_dist / "index.html").is_file(), \
        "web/dist missing - run `pnpm build` first (the e2e script does)"
    data = Path(tempfile.mkdtemp(prefix="pkm-e2e-"))
    db_path = data / "pkm.sqlite3"
    con = sqlite3.connect(db_path)
    con.executescript(DDL)
    con.commit()
    con.close()
    init_db(db_path)  # WAL + migrations, once, before serving
    (data / "assets").mkdir()
    config = Config(
        db_path=db_path,
        assets_dir=data / "assets",
        password_salt=SALT.hex(),
        password_hash=hash_password(PASSWORD, SALT),
        session_secret="ee" * 32,
        cookie_secure=False,
        web_dist=web_dist,
    )
    uvicorn.run(create_app(config), host="127.0.0.1", port=PORT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
