# pattern: Imperative Shell
"""Boot a throwaway server for the Playwright smoke: fresh empty DB in a
temp dir, fixed password "e2e-pw", serves the built SPA from web/dist.
Run: uv run python tests/e2e_serve.py   (from server/)

Also logs any unhandled exception (e.g. a real server bug, not a normal
4xx) to web/e2e/.server.log, which web/e2e/global-teardown.ts scans and
fails the run on -- see docs/2026-07-10-implementation-review.md finding 1,
where a real "database is locked" 500 was invisible to `pnpm e2e` because
nothing checked server-side errors.

Five extra env vars exist for `perfcheck.run`, the performance regression
check, and leave the defaults above unchanged when unset:
- E2E_FROM_DB: copy this DB into the temp data dir instead of creating an
  empty one (the perf fixture).
- E2E_FROZEN_NOW: run the server inside `time_machine.travel` at this ISO
  datetime, so every request sees a fixed clock.
- E2E_WEB_DIST: serve this web/dist instead of the repo's own, so a
  merge-base run can serve the base commit's build.
- E2E_SERVER_LOG: log unhandled exceptions here instead of
  web/e2e/.server.log, so a perf run never clobbers a `pnpm e2e` log.
- E2E_INSTANCE: echo this token in an X-E2E-Instance header on /healthz, so
  the perf check knows the server answering is the one it started."""
from __future__ import annotations

import atexit
import copy
import logging
import os
import shutil
import signal
import sqlite3
import sys
import tempfile
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from types import FrameType

import uvicorn
from fastapi import Request
from fastapi.responses import PlainTextResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

import fake_goodlinks_server
from fake_engine import FakeEngine
from pkm.schema import DDL
from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import init_db

PORT = int(os.environ.get("E2E_PORT", "8975"))
PASSWORD = "e2e-pw"
SALT = bytes.fromhex("11" * 16)

SERVER_LOGGER_NAME = "pkm.e2e_server"
server_logger = logging.getLogger(SERVER_LOGGER_NAME)


def _log_config(log_path: Path) -> dict:
    # uvicorn.run() calls logging.config.dictConfig(), which unconditionally
    # closes any handler that existed before the call (regardless of
    # disable_existing_loggers) -- so a FileHandler attached ahead of time
    # would silently stop writing. Folding it into uvicorn's own config
    # keeps it alive.
    config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    config["handlers"]["e2e_file"] = {
        "class": "logging.FileHandler",
        "filename": str(log_path),
        "mode": "w",
        "formatter": "default",
    }
    config["loggers"][SERVER_LOGGER_NAME] = {
        "handlers": ["e2e_file"], "level": "ERROR", "propagate": False,
    }
    return config


def server_log_path(root: Path, env: Mapping[str, str]) -> Path:
    return Path(env["E2E_SERVER_LOG"]) if env.get("E2E_SERVER_LOG") else root / "web" / "e2e" / ".server.log"


def with_instance_header(app: ASGIApp, token: str) -> ASGIApp:
    """Wrap `app` so /healthz answers with an X-E2E-Instance: <token> header."""
    header = (b"x-e2e-instance", token.encode())

    async def wrapped(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] != "/healthz":
            await app(scope, receive, send)
            return

        async def send_with_header(message: Message) -> None:
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*message.get("headers", []), header]}
            await send(message)
        await app(scope, receive, send_with_header)
    return wrapped


def prepare_db(data: Path, from_db: Path | None) -> Path:
    """Fresh empty DB, or a private copy of `from_db` (the perf fixture)."""
    data.mkdir(parents=True, exist_ok=True)
    db_path = data / "pkm.sqlite3"
    if from_db is not None:
        shutil.copyfile(from_db, db_path)
    else:
        con = sqlite3.connect(db_path)
        con.executescript(DDL)
        con.commit()
        con.close()
    init_db(db_path)  # WAL + migrations, once, before serving
    return db_path


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    web_dist = Path(os.environ["E2E_WEB_DIST"]) if os.environ.get("E2E_WEB_DIST") else root / "web" / "dist"
    assert (web_dist / "index.html").is_file(), \
        "web/dist missing - run `pnpm build` first (the e2e script does)"
    data = Path(tempfile.mkdtemp(prefix="pkm-e2e-"))
    atexit.register(shutil.rmtree, data, ignore_errors=True)

    # Belt-and-braces: uvicorn's own SIGINT/SIGTERM handling runs a graceful
    # shutdown, then restores whatever handler was installed before it took
    # over and re-raises the captured signal through it -- see
    # Server.capture_signals() in uvicorn/server.py. That re-raise hits the
    # OS default disposition (immediate termination, no atexit, exit status
    # reflecting the signal per Unix convention) unless we install our own
    # handler first, which becomes the one restored and runs instead --
    # cleaning up the temp dir and exiting 0 rather than by signal.
    def _handle_signal(signum: int, frame: FrameType | None) -> None:
        shutil.rmtree(data, ignore_errors=True)
        sys.exit(0)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    from_db = os.environ.get("E2E_FROM_DB")
    db_path = prepare_db(data, Path(from_db) if from_db else None)
    (data / "assets").mkdir()
    # A tiny local document root so web/e2e/local-docs.spec.ts can click a
    # Local copy:: link end to end (pkm-g1ep).
    local_root = data / "local" / "Papers"
    local_root.mkdir(parents=True)
    shutil.copy(root / "test-data" / "assets" / "sample.pdf", local_root / "sample.pdf")
    (local_root / "notes.zip").write_bytes(b"PK\x03\x04e2e")
    # A stub GoodLinks so web/e2e/goodlinks.spec.ts can resolve, save and
    # read an article without the real app.
    (data / "goodlinks_key").write_text(fake_goodlinks_server.TOKEN, encoding="utf-8")
    goodlinks = fake_goodlinks_server.start(0)
    atexit.register(goodlinks.shutdown)
    goodlinks_port = goodlinks.server_address[1]
    config = Config(
        db_path=db_path,
        assets_dir=data / "assets",
        password_salt=SALT.hex(),
        password_hash=hash_password(PASSWORD, SALT),
        session_secret="ee" * 32,
        cookie_secure=False,
        web_dist=web_dist,
        local_docs_root=data / "local",
        goodlinks_api_key_file=data / "goodlinks_key",
        goodlinks_api_url=f"http://127.0.0.1:{goodlinks_port}/api/v1",
    )
    app = create_app(config, assistant_engine=FakeEngine())

    @app.exception_handler(Exception)
    async def _log_unhandled(request: Request, exc: Exception) -> PlainTextResponse:
        server_logger.error("unhandled exception for %s %s",
                             request.method, request.url, exc_info=exc)
        return PlainTextResponse("internal server error", status_code=500)

    log_path = server_log_path(root, os.environ)
    instance = os.environ.get("E2E_INSTANCE")
    served: ASGIApp = with_instance_header(app, instance) if instance else app

    def run() -> None:
        uvicorn.run(served, host="127.0.0.1", port=PORT, log_config=_log_config(log_path))

    frozen = os.environ.get("E2E_FROZEN_NOW")
    if frozen:
        import time_machine
        with time_machine.travel(datetime.fromisoformat(frozen), tick=True):
            run()
    else:
        run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
