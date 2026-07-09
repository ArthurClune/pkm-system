"""Plan-4 carry-forward: the committed web/src/api/openapi.json (source of the
generated types.d.ts) must match the live schema, or the TS op types the
editor sends with are stale."""
import json
from pathlib import Path

from pkm.server.app import create_app
from pkm.server.config import Config

REGEN = ("regenerate with `uv run python -m pkm.server.openapi_dump "
         "> ../web/src/api/openapi.json` then `pnpm gen-types`, and commit "
         "both files")


def test_committed_openapi_matches_live_schema():
    root = Path(__file__).resolve().parents[2]
    committed = json.loads(
        (root / "web" / "src" / "api" / "openapi.json").read_text())
    config = Config(
        db_path=Path("/nonexistent/pkm.sqlite3"),
        assets_dir=Path("/nonexistent/assets"),
        password_salt="00" * 16,
        password_hash="ab" * 32,
        session_secret="cd" * 32,
        cookie_secure=False,
    )
    assert committed == create_app(config).openapi(), \
        f"web/src/api/openapi.json is stale: {REGEN}"
