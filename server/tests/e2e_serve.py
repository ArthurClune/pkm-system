# pattern: Imperative Shell
"""Boot a throwaway server for the Playwright smoke: fresh empty DB in a
temp dir, fixed password "e2e-pw", serves the built SPA from web/dist.
Run: uv run python tests/e2e_serve.py   (from server/)

Also logs any unhandled exception (e.g. a real server bug, not a normal
4xx) to web/e2e/.server.log, which web/e2e/global-teardown.ts scans and
fails the run on -- see docs/2026-07-10-implementation-review.md finding 1,
where a real "database is locked" 500 was invisible to `pnpm e2e` because
nothing checked server-side errors."""
from __future__ import annotations

import atexit
import copy
import logging
import shutil
import signal
import sqlite3
import sys
import tempfile
from pathlib import Path
from types import FrameType

import uvicorn
from fastapi import Request
from fastapi.responses import PlainTextResponse

from pkm.schema import DDL
from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import init_db

PORT = 8975
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


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    web_dist = root / "web" / "dist"
    assert (web_dist / "index.html").is_file(), \
        "web/dist missing - run `pnpm build` first (the e2e script does)"
    data = Path(tempfile.mkdtemp(prefix="pkm-e2e-"))
    atexit.register(shutil.rmtree, data, ignore_errors=True)

    # Belt-and-braces: uvicorn's own SIGINT/SIGTERM handling runs a graceful
    # shutdown, then restores whatever handler was installed before it took
    # over and re-raises the captured signal through it (so the process's
    # exit status reflects the signal, per Unix convention) -- see
    # Server.capture_signals() in uvicorn/server.py. That re-raise hits the
    # OS default disposition (immediate termination, no atexit) unless we
    # install our own handler first, which becomes the one restored.
    def _handle_signal(signum: int, frame: FrameType | None) -> None:
        shutil.rmtree(data, ignore_errors=True)
        sys.exit(0)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    db_path = data / "pkm.sqlite3"
    con = sqlite3.connect(db_path)
    con.executescript(DDL)
    con.commit()
    con.close()
    init_db(db_path)  # WAL + migrations, once, before serving
    (data / "assets").mkdir()
    config = Config(
        db_path=db_path,
        assets_dir=data / "assets",
        password_salt=SALT.hex(),
        password_hash=hash_password(PASSWORD, SALT),
        session_secret="ee" * 32,
        cookie_secure=False,
        web_dist=web_dist,
    )
    app = create_app(config)

    @app.exception_handler(Exception)
    async def _log_unhandled(request: Request, exc: Exception) -> PlainTextResponse:
        server_logger.error("unhandled exception for %s %s",
                             request.method, request.url, exc_info=exc)
        return PlainTextResponse("internal server error", status_code=500)

    log_path = root / "web" / "e2e" / ".server.log"
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_config=_log_config(log_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
