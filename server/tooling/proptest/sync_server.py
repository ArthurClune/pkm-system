# pattern: Imperative Shell
"""Test-only launcher for the web sync property harness: the real pkm app on
port 8978 plus a few /__proptest/* control routes that reset the database,
move the server clock, rotate the sync generation, and read applied_batches
and the page renames and deletes in commit order. The routes live here and
never in pkm.server.app.

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
import json
import logging
import os
import shutil
import signal
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Collection, Mapping, Sequence
from datetime import datetime
from pathlib import Path
from types import FrameType
from zoneinfo import ZoneInfo

import time_machine
import uvicorn
from fastapi import Depends, FastAPI, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from pkm.contracts.ops import BlockOp, OpBatch, SyncSeq
from pkm.database import Db
from pkm.refs import CanonicalTitle
from pkm.server import ops_apply, sync_meta
from pkm.server.app import create_app
from pkm.server.auth import require_auth
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import init_db, open_db
from pkm.server.notify import Frame, OpsFrame
from pkm.server.ops_apply import apply_batch
from pkm.server.ops_core import Effect, RewriteStep, rewrite_effects
from pkm.server.store import stale_titles

PORT = int(os.environ.get("PROPTEST_PORT", "8978"))
PASSWORD = "proptest-pw"
SALT = bytes.fromhex("22" * 16)
SEED_PAGE = "Proptest"
SEED_UIDS = tuple(f"pt_seed_{i}" for i in range(1, 6))
# pt_seed_6 is reserved: it is the only block of FIXTURE_PAGE, which no title
# pool draw, Rename, DeletePage or Edit names. It stays live on the server for
# the whole example, so a create of it is always a 400 (BadBatch) and every
# page in the title pool may be deleted.
FIXTURE_PAGE = "Fixture"
FIXTURE_UIDS = ("pt_seed_6",)
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
  at          INTEGER NOT NULL,
  ord         INTEGER NOT NULL
);
CREATE TRIGGER proptest_renames_au AFTER UPDATE OF title ON pages
WHEN OLD.title IS NOT NEW.title BEGIN
  INSERT INTO proptest_renames(old_title, new_title, after_batch, at, ord)
  VALUES (OLD.title, NEW.title,
          (SELECT COALESCE(MAX(rowid), 0) FROM applied_batches), NEW.updated_at,
          MAX(COALESCE((SELECT MAX(ord) FROM proptest_renames), 0),
              COALESCE((SELECT MAX(ord) FROM proptest_deletes), 0)) + 1);
END;
"""

# Harness-only: every recorded user page delete (a page_deletions insert, so
# daily notes and merges are absent), in commit order, shaped like the rename
# log and sharing its `ord` counter so the replay can interleave the two.
# `uids` is the JSON array of block uids the delete removed. The page's
# blocks are gone before page_deletions is written, so the trigger reads
# them from the change journal: delete_page_rows journals the block deletes
# (carrying the page id) directly before the page's own delete row, and the
# run of those rows ending at that row is exactly this delete's blocks;
# blocks an earlier op removed sit before a row of another kind.
DELETE_LOG_DDL = """
CREATE TABLE proptest_deletes(
  title       TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  after_batch INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  ord         INTEGER NOT NULL,
  uids        TEXT NOT NULL
);
CREATE TRIGGER proptest_deletes_ai AFTER INSERT ON page_deletions BEGIN
  INSERT INTO proptest_deletes(title, seq, after_batch, at, ord, uids)
  SELECT NEW.title, NEW.seq,
         (SELECT COALESCE(MAX(rowid), 0) FROM applied_batches), NEW.deleted_at,
         MAX(COALESCE((SELECT MAX(ord) FROM proptest_renames), 0),
             COALESCE((SELECT MAX(ord) FROM proptest_deletes), 0)) + 1,
         (SELECT COALESCE(json_group_array(entity_id), '[]') FROM (
            SELECT c.entity_id FROM changes c
             WHERE c.kind = 'block' AND c.deleted = 1 AND c.page_id = CAST(p.entity_id AS INTEGER)
               AND c.seq < p.seq
               AND c.seq > COALESCE((SELECT MAX(o.seq) FROM changes o
                                      WHERE o.seq < p.seq
                                        AND NOT (o.kind = 'block' AND o.deleted = 1
                                                 AND o.page_id = c.page_id)), 0)
             ORDER BY c.seq))
    FROM (SELECT seq, entity_id FROM changes
           WHERE kind = 'page' AND deleted = 1 ORDER BY seq DESC LIMIT 1) p;
END;
"""

# Harness-only: every daily-note conflict header the run wrote, in commit
# order, with the batch that wrote it. A header is a top-level block whose
# text starts `[[conflict]] `; it embeds `((uid))` of the block it is about,
# but a later delete of that block's page inlines the ref, so the snapshot
# alone cannot say which block a header was for. The ops route records the
# batch in applied_batches after its effects, so the batch that wrote a
# header is the first one after the highest rowid the trigger reads.
CONFLICT_LOG_DDL = """
CREATE TABLE proptest_conflicts(
  header_uid  TEXT NOT NULL,
  text        TEXT NOT NULL,
  after_batch INTEGER NOT NULL
);
CREATE TRIGGER proptest_conflicts_ai AFTER INSERT ON blocks
WHEN NEW.parent_uid IS NULL AND NEW.text LIKE '[[conflict]] %' BEGIN
  INSERT INTO proptest_conflicts(header_uid, text, after_batch)
  VALUES (NEW.uid, NEW.text,
          (SELECT COALESCE(MAX(rowid), 0) FROM applied_batches));
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


def _dicts(db: Db, sql: str) -> list[dict]:
    """Rows of a test-only table read by column name (their columns are not
    `Row` keys, so `Db.select` would not accept them)."""
    cursor = db.raw.execute(sql)
    names = [d[0] for d in cursor.description]
    return [dict(zip(names, values)) for values in cursor.fetchall()]


def build_template(path: Path) -> None:
    """A fresh DB holding page "Proptest" with five top-level blocks, page
    "Second" with three and page "Fixture" with one, written through the real
    op pipeline so the change journal and refs are as a client's creates would
    leave them, plus the rename, delete and conflict logs (RENAME_LOG_DDL,
    DELETE_LOG_DDL, CONFLICT_LOG_DDL). The app's schema setup is all IF NOT
    EXISTS and leaves a table and trigger it does not know alone."""
    init_db(path)
    con = open_db(path)
    try:
        ops = [{"op": "create", "uid": uid, "page_title": title, "parent_uid": None,
                "order_idx": i * 10, "text": f"{label} {i + 1}"}
               for title, label, uids in ((SEED_PAGE, "seed", SEED_UIDS),
                                          (SECOND_PAGE, "second", SECOND_UIDS),
                                          (FIXTURE_PAGE, "fixture", FIXTURE_UIDS))
               for i, uid in enumerate(uids)]
        batch = OpBatch.model_validate({
            "client_id": "proptest-seed", "batch_id": "proptest-seed-batch", "ops": ops})
        con.execute("BEGIN IMMEDIATE")
        apply_batch(con, batch, START_MS)
        con.commit()
        con.executescript(RENAME_LOG_DDL + DELETE_LOG_DDL + CONFLICT_LOG_DDL)
    finally:
        con.close()


# Harness-only teeth for the sync oracle's "delete wins": while armed, every
# batch is stale for no title, as before stale batches existed, so a stale
# create or link re-creates a deleted page. ops_apply reads stale_titles
# through its module global, which build_app points here; disarmed, it is
# the real function. Module state, not per app: one harness app serves at a
# time, and build_app and every reset disarm it.
_stale_teeth = {"empty": False}


def _stale_titles_with_teeth(db: Db,
                             seen_seq: SyncSeq | None) -> frozenset[CanonicalTitle]:
    return frozenset() if _stale_teeth["empty"] else stale_titles(db, seen_seq)


# Harness-only teeth for the sync oracle's "conflict noise": while armed, a
# hashed edit whose replay of a rename or delete changed the text it wrote
# records no rewrite rows for that replay, as before such rows existed, so
# the same device's next edit of the block, hashed against its own previous
# text, matches nothing and lands a conflict. Stale-unlink rows are kept.
# ops_apply reads rewrite_effects through its module global, which build_app
# points here; disarmed, it is the real function. Reset disarms it, as it
# does _stale_teeth.
_rewrite_teeth = {"drop_replayed": False}


def _rewrite_effects_with_teeth(original: BlockOp, planned: tuple[Effect, ...],
                                stale: Collection[CanonicalTitle],
                                canonical: Callable[[str], str],
                                replayed: Sequence[RewriteStep] = (),
                                settled: str | None = None) -> tuple[Effect, ...]:
    if _rewrite_teeth["drop_replayed"]:
        replayed = ()
    return rewrite_effects(original, planned, stale, canonical, replayed, settled)


class _ClockBody(BaseModel):
    ms: int


class _TeethBody(BaseModel):
    drop_cross_page_title: bool


class _StaleTeethBody(BaseModel):
    empty: bool


class _RewriteTeethBody(BaseModel):
    drop_replayed: bool


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

    async def recording_broadcast(message: Frame) -> None:
        ops = message.ops if isinstance(message, OpsFrame) else None
        if ops is not None:
            recorded = copy.deepcopy(ops)
            if echo["drop_cross_page_title"]:
                for op in recorded:
                    if op.get("op") == "move" and op.get("page_title") is not None:
                        op["page_title"] = None
            echo["ops"] = recorded
        await broadcast(message)

    app.state.hub.broadcast = recording_broadcast
    ops_apply.stale_titles = _stale_titles_with_teeth
    _stale_teeth["empty"] = False
    ops_apply.rewrite_effects = _rewrite_effects_with_teeth
    _rewrite_teeth["drop_replayed"] = False

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
        _stale_teeth["empty"] = False
        _rewrite_teeth["drop_replayed"] = False
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
            rows = _dicts(con,
                "SELECT batch_id, applied_at FROM applied_batches ORDER BY rowid")
        finally:
            con.close()
        return [{"batch_id": r["batch_id"], "applied_at": r["applied_at"]} for r in rows]

    @app.get("/__proptest/renames", dependencies=[Depends(require_auth)])
    def renames(request: Request) -> list[dict]:
        con = open_db(request.app.state.config.db_path)
        try:
            # The batch each followed by id: the serial replay walks
            # /__proptest/applied's list, which names batches, not rowids.
            rows = _dicts(con,
                "SELECT r.old_title, r.new_title, a.batch_id AS after_batch_id, r.at, r.ord"
                " FROM proptest_renames r"
                " LEFT JOIN applied_batches a ON a.rowid = r.after_batch"
                " ORDER BY r.rowid")
        finally:
            con.close()
        return rows

    @app.get("/__proptest/deletes", dependencies=[Depends(require_auth)])
    def deletes(request: Request) -> list[dict]:
        con = open_db(request.app.state.config.db_path)
        try:
            rows = _dicts(con,
                "SELECT d.title, d.seq, a.batch_id AS after_batch_id, d.at, d.ord, d.uids"
                " FROM proptest_deletes d"
                " LEFT JOIN applied_batches a ON a.rowid = d.after_batch"
                " ORDER BY d.rowid")
        finally:
            con.close()
        return [{**r, "uids": json.loads(r["uids"])} for r in rows]

    @app.get("/__proptest/conflicts", dependencies=[Depends(require_auth)])
    def conflicts(request: Request) -> list[dict]:
        con = open_db(request.app.state.config.db_path)
        try:
            rows = _dicts(con,
                "SELECT c.header_uid, c.text,"
                " (SELECT a.batch_id FROM applied_batches a WHERE a.rowid > c.after_batch"
                "   ORDER BY a.rowid LIMIT 1) AS batch_id"
                " FROM proptest_conflicts c ORDER BY c.rowid")
        finally:
            con.close()
        return rows

    @app.post("/__proptest/echo/take", dependencies=[Depends(require_auth)])
    def echo_take() -> dict:
        ops, echo["ops"] = echo["ops"], None
        return {"ops": ops}

    @app.post("/__proptest/echo/teeth", dependencies=[Depends(require_auth)])
    def echo_teeth(body: _TeethBody) -> dict:
        echo["drop_cross_page_title"] = body.drop_cross_page_title
        return {"drop_cross_page_title": body.drop_cross_page_title}

    @app.post("/__proptest/stale/teeth", dependencies=[Depends(require_auth)])
    def stale_teeth(body: _StaleTeethBody) -> dict:
        _stale_teeth["empty"] = body.empty
        return {"empty": body.empty}

    @app.post("/__proptest/rewrites/teeth", dependencies=[Depends(require_auth)])
    def rewrite_teeth(body: _RewriteTeethBody) -> dict:
        _rewrite_teeth["drop_replayed"] = body.drop_replayed
        return {"drop_replayed": body.drop_replayed}

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
    os.environ["PKM_ROW_CHECK"] = "1"
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
