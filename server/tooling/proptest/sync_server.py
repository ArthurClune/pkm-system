# pattern: Imperative Shell
"""Test-only launcher for the web sync property harness: the real pkm app on
port 8978 plus a few /__proptest/* control routes that reset the database,
move the server clock, rotate the sync generation, and read applied_batches
and the page renames in commit order. The routes live here and never in
pkm.server.app.

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
# A second page, so moves and creates can cross pages.
SECOND_PAGE = "Second"
SECOND_UIDS = tuple(f"pt_sec_{i}" for i in range(1, 4))

# Harness-only: every page retitle, in commit order, with the applied batch
# it followed. A rename is a route of its own, not a batch, so the serial
# replay could not otherwise put it back between the right two batches.
# The trigger runs inside the rename's own write transaction, so the
# highest applied_batches rowid it reads is exactly the last batch that
# committed before it (no applied_batches row is ever deleted). `at` is the
# page's new updated_at: the rename route stamps it with the server clock
# it ran at, the same now_ms its block rewrites carry, so a replay with the
# clock set there reproduces every timestamp the rename wrote. Only the
# rename route retitles a page while the harness runs (the title migration
# route is never called), and nothing the oracle compares reads this table.
RENAME_LOG_DDL = """
CREATE TABLE proptest_renames(
  old_title   TEXT NOT NULL,
  new_title   TEXT NOT NULL,
  after_batch INTEGER NOT NULL,
  at          INTEGER NOT NULL
);
CREATE TRIGGER proptest_renames_au AFTER UPDATE OF title ON pages
WHEN OLD.title IS NOT NEW.title BEGIN
  INSERT INTO proptest_renames(old_title, new_title, after_batch, at)
  VALUES (OLD.title, NEW.title,
          (SELECT COALESCE(MAX(rowid), 0) FROM applied_batches), NEW.updated_at);
END;
"""
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
    """A fresh DB holding page "Proptest" with six top-level blocks and page
    "Second" with three, written through the real op pipeline so the change
    journal and refs are as a client's creates would leave them, plus the
    rename log (RENAME_LOG_DDL). The app's schema setup is all IF NOT
    EXISTS and leaves a table and trigger it does not know alone."""
    init_db(path)
    con = open_db(path)
    try:
        ops = [{"op": "create", "uid": uid, "page_title": title, "parent_uid": None,
                "order_idx": i * 10, "text": f"{label} {i + 1}"}
               for title, label, uids in ((SEED_PAGE, "seed", SEED_UIDS),
                                          (SECOND_PAGE, "second", SECOND_UIDS))
               for i, uid in enumerate(uids)]
        batch = OpBatch.model_validate({
            "client_id": "proptest-seed", "batch_id": "proptest-seed-batch", "ops": ops})
        con.execute("BEGIN IMMEDIATE")
        apply_batch(con, batch, START_MS)
        con.commit()
        con.executescript(RENAME_LOG_DDL)
    finally:
        con.close()


class _ClockBody(BaseModel):
    ms: int


class _TeethBody(BaseModel):
    drop_cross_page_title: bool


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

    # The ops of the last broadcast frame that carried any (seq nudges carry
    # none), kept until taken or reset. With teeth armed the recorded copy
    # loses the page_title of every move that names one, a deliberate echo
    # corruption the ops suite must notice.
    echo: dict = {"ops": None, "drop_cross_page_title": False}
    broadcast = app.state.hub.broadcast

    async def recording_broadcast(message: dict) -> None:
        ops = message.get("ops")
        if ops is not None:
            recorded = copy.deepcopy(ops)
            if echo["drop_cross_page_title"]:
                for op in recorded:
                    if op.get("op") == "move" and op.get("page_title") is not None:
                        op["page_title"] = None
            echo["ops"] = recorded
        await broadcast(message)

    app.state.hub.broadcast = recording_broadcast

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
        echo["ops"] = None
        echo["drop_cross_page_title"] = False
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

    @app.get("/__proptest/renames", dependencies=[Depends(require_auth)])
    def renames(request: Request) -> list[dict]:
        con = open_db(request.app.state.config.db_path)
        try:
            # The batch each followed by id: the serial replay walks
            # /__proptest/applied's list, which names batches, not rowids.
            rows = con.execute(
                "SELECT r.old_title, r.new_title, a.batch_id AS after_batch_id, r.at"
                " FROM proptest_renames r"
                " LEFT JOIN applied_batches a ON a.rowid = r.after_batch"
                " ORDER BY r.rowid").fetchall()
        finally:
            con.close()
        return [dict(r) for r in rows]

    @app.post("/__proptest/echo/take", dependencies=[Depends(require_auth)])
    def echo_take() -> dict:
        ops, echo["ops"] = echo["ops"], None
        return {"ops": ops}

    @app.post("/__proptest/echo/teeth", dependencies=[Depends(require_auth)])
    def echo_teeth(body: _TeethBody) -> dict:
        echo["drop_cross_page_title"] = body.drop_cross_page_title
        return {"drop_cross_page_title": body.drop_cross_page_title}

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
