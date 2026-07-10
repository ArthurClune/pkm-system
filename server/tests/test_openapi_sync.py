"""Plan-4 carry-forward: the committed web/src/api/openapi.json (source of the
generated types.d.ts) must match the live schema, or the TS op types the
editor sends with are stale.

The read-response guard below is the pkm-5nrm addition: it asserts each read
route is backed by a named response-model component, so reverting a route to a
bare `-> dict` (which drops the response contract from the schema) fails even
after openapi.json is regenerated to match."""
import json
from pathlib import Path

from pkm.server.app import create_app
from pkm.server.config import Config

REGEN = ("regenerate with `uv run python -m pkm.server.openapi_dump "
         "> ../web/src/api/openapi.json` then `pnpm gen-types`, and commit "
         "both files")

# Read routes whose JSON body must resolve to a generated schema component.
# Both /api/unlinked and /api/query return the shared {groups, total} shape.
RESPONSE_MODELS = {
    ("/api/page/{title}", "get"): "PagePayload",
    ("/api/unlinked", "get"): "GroupsPayload",
    ("/api/query", "get"): "GroupsPayload",
    ("/api/journal", "get"): "JournalPayload",
    ("/api/search", "get"): "SearchPayload",
    ("/api/titles", "get"): "TitlesPayload",
    ("/api/sidebar", "get"): "SidebarNavPayload",
    ("/api/assets", "post"): "AssetUploadResponse",
}


def _dummy_config() -> Config:
    return Config(
        db_path=Path("/nonexistent/pkm.sqlite3"),
        assets_dir=Path("/nonexistent/assets"),
        password_salt="00" * 16,
        password_hash="ab" * 32,
        session_secret="cd" * 32,
        cookie_secure=False,
    )


def test_committed_openapi_matches_live_schema():
    root = Path(__file__).resolve().parents[2]
    committed = json.loads(
        (root / "web" / "src" / "api" / "openapi.json").read_text())
    assert committed == create_app(_dummy_config()).openapi(), \
        f"web/src/api/openapi.json is stale: {REGEN}"


def test_read_routes_declare_response_models():
    schema = create_app(_dummy_config()).openapi()
    for (path, method), name in RESPONSE_MODELS.items():
        body = (schema["paths"][path][method]["responses"]["200"]
                ["content"]["application/json"]["schema"])
        assert body.get("$ref") == f"#/components/schemas/{name}", (
            f"{method.upper()} {path} must declare response_model={name}; "
            f"got schema {body!r}")
        assert name in schema["components"]["schemas"], \
            f"{name} missing from generated components"
