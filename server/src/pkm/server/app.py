# pattern: Imperative Shell
"""FastAPI application factory."""
from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI

from pkm.server.auth import require_auth, router as auth_router
from pkm.server.config import Config
from pkm.server.routes_pages import router as pages_router


def create_app(config: Config) -> FastAPI:
    app = FastAPI(
        title="pkm", docs_url=None, redoc_url=None, openapi_url=None
    )
    app.state.config = config
    app.include_router(auth_router)

    api = APIRouter(dependencies=[Depends(require_auth)])

    @api.get("/api/openapi.json")
    def openapi_schema() -> dict:
        return app.openapi()

    app.include_router(api)
    app.include_router(pages_router)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    return app
