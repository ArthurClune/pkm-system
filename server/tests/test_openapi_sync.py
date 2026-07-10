"""Plan-4 carry-forward: the committed web/src/api/openapi.json (source of the
generated types.d.ts) must match the live schema, or the TS op types the
editor sends with are stale.

The read-response guard below is the pkm-5nrm addition: it asserts each read
route is backed by a named response-model component, so reverting a route to a
bare `-> dict` (which drops the response contract from the schema) fails even
after openapi.json is regenerated to match. pkm-2939 replaced the original
hardcoded path->model map with auto-discovery from the OpenAPI document
itself, so a brand-new GET route added later is covered with no map edit."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI

from pkm.server.app import create_app
from pkm.server.config import Config

REGEN = ("regenerate with `uv run python -m pkm.server.openapi_dump "
         "> ../web/src/api/openapi.json` then `pnpm gen-types`, and commit "
         "both files")

# GET routes that are exempt from the "must declare a response_model" rule
# because they don't return a JSON API payload: a health check, the schema
# introspection endpoint itself, and a binary file download. Keep this list
# explicit and minimal - anything else returning bare-dict JSON is a bug.
EXEMPT_READ_ROUTES = {"/healthz", "/api/openapi.json", "/assets/{sha256}/{filename}"}


def _get_routes(schema: dict) -> list[tuple[str, dict]]:
    return [(path, methods["get"])
            for path, methods in schema["paths"].items() if "get" in methods]


def _undeclared_response_model_routes(schema: dict, exempt: set[str]) -> list[str]:
    """GET routes (outside `exempt`) whose 200 JSON body isn't a named
    component ($ref) - i.e. would be a bare/untyped dict in the schema."""
    bad = []
    for path, op in _get_routes(schema):
        if path in exempt:
            continue
        body = op["responses"]["200"].get("content", {}).get("application/json")
        if body is None:
            continue  # not a JSON response (e.g. an HTML page)
        if not body.get("schema", {}).get("$ref"):
            bad.append(path)
    return bad


def _dummy_config(tmp_path: Path) -> Config:
    return Config(
        db_path=tmp_path / "pkm.sqlite3",
        assets_dir=tmp_path / "assets",
        password_salt="00" * 16,
        password_hash="ab" * 32,
        session_secret="cd" * 32,
        cookie_secure=False,
    )


def test_committed_openapi_matches_live_schema(tmp_path):
    root = Path(__file__).resolve().parents[2]
    committed = json.loads(
        (root / "web" / "src" / "api" / "openapi.json").read_text())
    assert committed == create_app(_dummy_config(tmp_path)).openapi(), \
        f"web/src/api/openapi.json is stale: {REGEN}"


def test_read_routes_declare_response_models(tmp_path):
    schema = create_app(_dummy_config(tmp_path)).openapi()
    bad = _undeclared_response_model_routes(schema, EXEMPT_READ_ROUTES)
    assert not bad, (
        f"GET route(s) {bad} must declare response_model=<Payload> (see "
        f"pkm.server.response_models) or be added to EXEMPT_READ_ROUTES if "
        f"genuinely not a JSON API payload; {REGEN}")


def test_undeclared_response_model_checker_catches_a_bare_dict_route():
    # Guards the guard: a fresh route with no response_model must be flagged,
    # proving test_read_routes_declare_response_models would fail on it.
    app = FastAPI()

    @app.get("/api/fake")
    def fake() -> dict:
        return {"ok": True}

    assert _undeclared_response_model_routes(app.openapi(), exempt=set()) == \
        ["/api/fake"]
