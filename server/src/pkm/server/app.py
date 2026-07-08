# pattern: Imperative Shell
"""FastAPI application factory."""
from __future__ import annotations

from fastapi import FastAPI

from pkm.server.config import Config


def create_app(config: Config) -> FastAPI:
    app = FastAPI(title="pkm", openapi_url="/api/openapi.json")
    app.state.config = config

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    return app
