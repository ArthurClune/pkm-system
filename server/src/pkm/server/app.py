# pattern: Imperative Shell
"""FastAPI application factory."""
from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from pkm.server.auth import require_auth, router as auth_router
from pkm.server.config import Config
from pkm.server.routes_assets import router as assets_router
from pkm.server.routes_ops import router as ops_router
from pkm.server.routes_pages import router as pages_router
from pkm.server.routes_search import router as search_router
from pkm.server.routes_sidebar import router as sidebar_router
from pkm.server.ws import Hub, router as ws_router


def create_app(config: Config) -> FastAPI:
    app = FastAPI(
        title="pkm", docs_url=None, redoc_url=None, openapi_url=None
    )
    app.state.config = config
    app.state.hub = Hub()
    app.include_router(auth_router)

    api = APIRouter(dependencies=[Depends(require_auth)])

    @api.get("/api/openapi.json")
    def openapi_schema() -> dict:
        return app.openapi()

    app.include_router(api)
    app.include_router(ops_router)
    app.include_router(pages_router)
    app.include_router(search_router)
    app.include_router(sidebar_router)
    app.include_router(assets_router)
    app.include_router(ws_router)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    if config.web_dist is not None:
        app.mount("/app-assets",
                  StaticFiles(directory=config.web_dist / "app-assets"),
                  name="app-assets")
        index_html = config.web_dist / "index.html"

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str) -> FileResponse:
            # Real API/asset routes are registered earlier and win; anything
            # still hitting these prefixes is a miss, not a client-side route.
            if full_path.split("/", 1)[0] in ("api", "assets", "app-assets"):
                raise HTTPException(status_code=404, detail="not found")
            # index.html references hashed bundle filenames, so it must be
            # revalidated on every request or browsers keep serving stale
            # bundle references after a deploy.
            return FileResponse(index_html, headers={"Cache-Control": "no-cache"})

    return app
