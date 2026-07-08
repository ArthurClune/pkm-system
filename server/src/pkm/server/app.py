# pattern: Imperative Shell
"""FastAPI application factory."""
from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI

from pkm.server.auth import require_auth, router as auth_router
from pkm.server.config import Config


def create_app(config: Config) -> FastAPI:
    app = FastAPI(title="pkm", openapi_url="/api/openapi.json")
    app.state.config = config
    app.include_router(auth_router)

    api = APIRouter(dependencies=[Depends(require_auth)])

    @api.get("/api/page/{title:path}")
    def page_placeholder(title: str) -> dict:  # replaced in Task 4
        return {"title": title}

    app.include_router(api)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    return app
