# pattern: Imperative Shell
"""Dump the OpenAPI schema for TS type generation:
python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
Builds a throwaway app from a dummy Config in a scratch temp dir, so it
touches no real database. create_app() runs init_db() on the db_path it is
given, which is why that path sits in a writable directory."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from pkm.server.app import create_app
from pkm.server.config import Config


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        config = Config(
            db_path=Path(tmp) / "pkm.sqlite3",
            assets_dir=Path(tmp) / "assets",
            password_salt="00" * 16,  # dummy hex — Config fields must parse as hex
            password_hash="ab" * 32,
            session_secret="cd" * 32,
            cookie_secure=False,
        )
        print(json.dumps(create_app(config).openapi(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
