# pattern: Imperative Shell
"""Dump the OpenAPI schema for TS type generation:
python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
Builds a throwaway app from a dummy Config; touches no database."""
from __future__ import annotations

import json
from pathlib import Path

from pkm.server.app import create_app
from pkm.server.config import Config


def main() -> int:
    config = Config(
        db_path=Path("/nonexistent/pkm.sqlite3"),
        assets_dir=Path("/nonexistent/assets"),
        password_salt="00" * 16,   # dummy hex — Config fields must parse as hex
        password_hash="ab" * 32,
        session_secret="cd" * 32,
        cookie_secure=False,
    )
    print(json.dumps(create_app(config).openapi(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
