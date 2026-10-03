# pattern: Imperative Shell
"""Test-only launcher for the web sync property harness: the real pkm app on
port 8978 plus a few /__proptest/* control routes that reset the database,
move the server clock, rotate the sync generation and read applied_batches
in commit order. The routes live here and never in pkm.server.app.

Run (cwd server/, as proptest/check.sh runs run.py):
    TZ=Europe/London PYTHONPATH=tooling uv run python -m proptest.sync_server

Invariant: the harness logs in once, at START_MS, and the clock never moves
before START_MS or more than a year past it. Session cookies are signed with
the server clock and rejected when issued more than 5 minutes in the future
or more than a year ago, so any other clock position would log the harness out.
"""
from __future__ import annotations

import atexit
import copy
import dataclasses
import itertools
import logging
import os
import shutil
import signal
import sys
import tempfile
import threading
import time
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from types import FrameType
from zoneinfo import ZoneInfo

import time_machine
import uvicorn
from fastapi import Depends, FastAPI, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from pkm.contracts.ops import OpBatch
from pkm.server import sync_meta
from pkm.server.app import create_app
from pkm.server.auth import require_auth
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import init_db, open_db
from pkm.server.ops_apply import apply_batch

PORT = int(os.environ.get("PROPTEST_PORT", "8978"))
PASSWORD = "proptest-pw"
SALT = bytes.fromhex("22" * 16)
SEED_PAGE = "Proptest"
# pt_seed_6 is reserved: no generated Edit targets it, so it is live on the
# server for the whole example and a create of it is always a 400 (BadBatch).
SEED_UIDS = tuple(f"pt_seed_{i}" for i in range(1, 7))
START_MS = int(datetime(2026, 3, 1, 12, 0, 0, tzinfo=ZoneInfo("Europe/London")).timestamp() * 1000)

logger = logging.getLogger("pkm.proptest_server")


class Clock:
    """The server clock: a time_machine traveller that never ticks, moved
    explicitly. Starts at START_MS."""

    def __init__(self) -> None:
        self._travel = time_machine.travel(START_MS / 1000, tick=False)
        self._traveller = self._travel.start()

    def set_ms(self, ms: int) -> None:
        self._traveller.move_to(ms / 1000)

    def stop(self) -> None:
        self._travel.stop()


def build_template(path: Path) -> None:
    """A fresh DB holding page "Proptest" with six top-level blocks, written
    through the real op pipeline so the change journal and refs are as a
    client's creates would leave them."""
    init_db(path)
    con = open_db(path)
    try:
        batch = OpBatch.model_validate({
            "client_id": "proptest-seed", "batch_id": "proptest-seed-batch",
            "ops": [{"op": "create", "uid": uid, "page_title": SEED_PAGE, "parent_uid": None,
                     "order_idx": i * 10, "text": f"seed {i + 1}"}
                    for i, uid in enumerate(SEED_UIDS)]})
        con.execute("BEGIN IMMEDIATE")
        apply_batch(con, batch, START_MS)
        con.commit()
    finally:
        con.close()


class _ClockBody(BaseModel):
    ms: int


def build_app(data: Path, clock: Clock, config: Config | None = None) -> FastAPI:
    data.mkdir(parents=True, exist_ok=True)
    (data / "assets").mkdir(exist_ok=True)
    template = data / "template.sqlite3"
    build_template(template)
    db_numbers = itertools.count(1)
    if config is None:
        config = Config(
            db_path=template, assets_dir=data / "assets",
            password_salt=SALT.hex(), password_hash=hash_password(PASSWORD, SALT),
            session_secret="ff" * 32, cookie_secure=False,
            openai_api_key_file=data / "no_openai_key", zai_api_key_file=data / "no_zai_key",
            goodlinks_api_key_file=data / "no_goodlinks_key")
    # The template is never served: each example, and the server's first
    # requests before any reset, run on a private copy of it.
    def fresh_copy() -> Path:
        db_path = data / f"db-{next(db_numbers)}.sqlite3"
        shutil.copyfile(template, db_path)
        return db_path

    app = create_app(dataclasses.replace(config, db_path=fresh_copy()))

    @app.post("/__proptest/reset", dependencies=[Depends(require_auth)])
    def reset(request: Request) -> dict:
        # app.state audit: config is the only attribute bound to the DB
        # (every request opens its own connection from config.db_path).
        # hub holds websocket clients only, login_throttle holds login
        # attempts, assistant and goodlinks hold no DB path, and describe
        # keeps the construction-time config but is disabled here (no
        # OpenAI key), so it never opens a DB. No title or query cache
        # exists on app.state, so there is nothing else to clear.
        db_path = fresh_copy()
        request.app.state.config = dataclasses.replace(request.app.state.config, db_path=db_path)
        clock.set_ms(START_MS)
        return {"db_path": str(db_path)}

    @app.post("/__proptest/clock", dependencies=[Depends(require_auth)])
    def set_clock(body: _ClockBody) -> dict:
        clock.set_ms(body.ms)
        return {"ms": body.ms}

    @app.post("/__proptest/rotate-generation", dependencies=[Depends(require_auth)])
    def rotate(request: Request) -> dict:
        con = open_db(request.app.state.config.db_path)
        try:
            generation = sync_meta.rotate_database_generation(con)
            con.commit()
        finally:
            con.close()
        return {"generation": generation}

    @app.get("/__proptest/applied", dependencies=[Depends(require_auth)])
    def applied(request: Request) -> list[dict]:
        con = open_db(request.app.state.config.db_path)
        try:
            rows = con.execute(
                "SELECT batch_id, applied_at FROM applied_batches ORDER BY rowid").fetchall()
        finally:
            con.close()
        return [{"batch_id": r["batch_id"], "applied_at": r["applied_at"]} for r in rows]

    return app


def log_path(env: Mapping[str, str], data: Path) -> Path:
    return Path(env["PROPTEST_SERVER_LOG"]) if env.get("PROPTEST_SERVER_LOG") else data / "server.log"


def _log_config(path: Path) -> dict:
    # uvicorn's dictConfig closes handlers attached beforehand, so the file
    # handler has to be part of its config.
    config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    config["handlers"]["proptest_file"] = {
        "class": "logging.FileHandler", "filename": str(path), "mode": "w", "formatter": "default"}
    config["loggers"]["pkm.proptest_server"] = {
        "handlers": ["proptest_file"], "level": "ERROR", "propagate": False}
    return config


def _watch_parent(initial_ppid: int, poll_s: float = 2.0) -> None:
    while os.getppid() == initial_ppid:
        time.sleep(poll_s)
    os.kill(os.getpid(), signal.SIGTERM)


def main() -> int:  # pragma: no cover - process entry point, exercised by the smoke run
    data = Path(tempfile.mkdtemp(prefix="pkm-proptest-"))
    atexit.register(shutil.rmtree, data, ignore_errors=True)

    def _handle_signal(signum: int, frame: FrameType | None) -> None:
        shutil.rmtree(data, ignore_errors=True)
        sys.exit(0)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    threading.Thread(target=_watch_parent, args=(os.getppid(),), daemon=True).start()

    web_dist = data / "dist"
    web_dist.mkdir()
    (web_dist / "app-assets").mkdir()
    (web_dist / "index.html").write_text("<!doctype html><title>proptest</title>", encoding="utf-8")

    clock = Clock()
    app = build_app(data, clock)
    app.state.config = dataclasses.replace(app.state.config, web_dist=web_dist)

    @app.exception_handler(Exception)
    async def _log_unhandled(request: Request, exc: Exception) -> PlainTextResponse:
        logger.error("unhandled exception for %s %s", request.method, request.url, exc_info=exc)
        return PlainTextResponse("internal server error", status_code=500)

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_config=_log_config(log_path(os.environ, data)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
