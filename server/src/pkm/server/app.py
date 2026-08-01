# pattern: Imperative Shell
"""FastAPI application factory."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from pkm.assistant.engine import AgentEngine
from pkm.assistant.routes import router as assistant_router
from pkm.assistant.service import AssistantService
from pkm.describe.core import enabled_reason
from pkm.describe.openai_client import OpenAIDescriber
from pkm.describe.routes import router as describe_router
from pkm.describe.service import DescribeService
from pkm.server.auth import LoginThrottle, require_auth, router as auth_router
from pkm.server.config import Config
from pkm.server.db import init_db
from pkm.server.request_log import RequestLogMiddleware
from pkm.server.routes_assets import router as assets_router
from pkm.server.routes_export import router as export_router
from pkm.server.routes_ops import router as ops_router
from pkm.server.routes_pages import router as pages_router
from pkm.server.routes_search import router as search_router
from pkm.server.routes_sidebar import router as sidebar_router
from pkm.server.routes_sync import router as sync_router
from pkm.server.ws import Hub, router as ws_router


def _read_key_file(path: Path) -> str | None:
    """Stripped file contents, or None for anything short of a readable,
    UTF-8, non-empty file — a missing/unreadable/undecodable key file must
    degrade to "disabled", never crash the app factory. UnicodeDecodeError
    is a ValueError subclass, not an OSError, so it needs its own arm."""
    try:
        key = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None
    return key or None


def _default_describe_service(config: Config) -> DescribeService:
    # Precedence: the key file first, then OPENAI_API_KEY env var. A user
    # may have a general-purpose OPENAI_API_KEY in their environment but
    # want a pkm-specific key on disk for its own cost attribution, so the
    # file — the pkm-specific, deliberately-provisioned source — wins.
    api_key = (_read_key_file(config.openai_api_key_file)
              or os.environ.get("OPENAI_API_KEY") or None)
    reason = enabled_reason(api_key, config.image_descriptions)
    if reason is not None:
        return DescribeService(config, None, reason)
    assert api_key is not None
    return DescribeService(
        config, OpenAIDescriber(api_key, config.image_description_model), None)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    app.state.describe.start()
    yield
    try:
        await app.state.describe.close()
    finally:
        await app.state.assistant.close_all()


def create_app(
    config: Config,
    *,
    api_port: int = 8974,
    assistant_engine: AgentEngine | None = None,
    describe_service: DescribeService | None = None,
) -> FastAPI:
    # init_db() is idempotent and cheap (one WAL pragma + the fully
    # IF-NOT-EXISTS base schema, see schema.py), so calling it here makes
    # WAL mode + a working schema un-forgettable for any entrypoint or
    # direct create_app(config) call that serves DB routes -- including a
    # brand-new data dir that never had an import run against it
    # (pkm-cqu2) -- rather than relying on every caller remembering to run
    # it first (run.py used to be the only such call).
    init_db(config.db_path)
    app = FastAPI(
        title="pkm", docs_url=None, redoc_url=None, openapi_url=None,
        lifespan=_lifespan,
    )
    app.state.config = config
    app.state.hub = Hub()
    app.state.login_throttle = LoginThrottle()
    if assistant_engine is None:
        from pkm.assistant.claude_engine import ClaudeEngine

        assistant_engine = ClaudeEngine(
            base_url=f"http://127.0.0.1:{api_port}",
            session_secret_hex=config.session_secret,
        )
    app.state.assistant = AssistantService(assistant_engine)
    app.state.describe = (describe_service if describe_service is not None
                          else _default_describe_service(config))
    app.add_middleware(RequestLogMiddleware)
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
    app.include_router(sync_router)
    app.include_router(assets_router)
    app.include_router(describe_router)
    app.include_router(export_router)
    app.include_router(ws_router)
    app.include_router(assistant_router)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    if config.web_dist is not None:
        app.mount("/app-assets",
                  StaticFiles(directory=config.web_dist / "app-assets"),
                  name="app-assets")
        index_html = config.web_dist / "index.html"

        web_dist_root = config.web_dist.resolve()

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str) -> FileResponse:
            # Real API/asset routes are registered earlier and win; anything
            # still hitting these prefixes is a miss, not a client-side route.
            if full_path.split("/", 1)[0] in ("api", "assets", "app-assets"):
                raise HTTPException(status_code=404, detail="not found")
            # Root-level build files (sw.js, manifest.webmanifest, icons)
            # must be served as themselves: a service worker script that
            # falls back to index.html breaks registration outright. The SW
            # byte-compares itself on update checks, so no-cache keeps
            # deploys picked up promptly (matching index.html below).
            candidate = (web_dist_root / full_path).resolve()
            if (full_path
                    and candidate.is_relative_to(web_dist_root)
                    and candidate.is_file()):
                return FileResponse(candidate,
                                    headers={"Cache-Control": "no-cache"})
            # index.html references hashed bundle filenames, so it must be
            # revalidated on every request or browsers keep serving stale
            # bundle references after a deploy.
            return FileResponse(index_html, headers={"Cache-Control": "no-cache"})

    return app
