# pattern: Imperative Shell
"""SQLite connection helper and FastAPI dependencies."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi import Request

from pkm.refs import extract
from pkm.schema import DDL
from pkm.server.config import Config


# Genuine writer contention (two connections' write transactions racing)
# should retry briefly rather than fail outright; init_db() below removes
# the far larger, un-retriable source of lock errors (per-connection
# WAL/DDL setup racing an in-flight transaction).
BUSY_TIMEOUT_MS = 5000


def _ensure_schema_migrations(con: sqlite3.Connection) -> None:
    """Apply additive migrations that cannot be expressed with IF NOT EXISTS."""
    columns = {row[1] for row in con.execute("PRAGMA table_info(blocks)")}
    if "view_type" not in columns:
        con.execute(
            "ALTER TABLE blocks ADD COLUMN view_type TEXT "
            "CHECK(view_type IN ('numbered','document'))")
    asset_columns = {row[1] for row in con.execute("PRAGMA table_info(assets)")}
    for col, decl in (("description", "TEXT"), ("described_at", "INTEGER"),
                      ("describe_error", "TEXT")):
        if col not in asset_columns:
            con.execute(f"ALTER TABLE assets ADD COLUMN {col} {decl}")


def _backfill_created_at(con: sqlite3.Connection) -> None:
    """pkm-r7k8: fill NULL blocks.created_at from the block's page, for
    blocks that predate created_at existing (old Roam imports lacking
    :create/time). MIN() of the page's created_at and the block's own
    updated_at, because a merged/moved block can sit on a page created
    after the block was last edited -- taking the page's value alone could
    then mint a created_at *after* updated_at, which no genuine "created"
    timestamp should ever be. COALESCE covers pages whose own created_at is
    NULL, falling back to the block's updated_at so the UPDATE can never
    write NULL back. Plain `WHERE created_at IS NULL` makes this a no-op
    on any later run, and it is a normal UPDATE -- the blocks_chg_au
    trigger fires as usual, so replicas pick the backfilled values up
    through ordinary sync."""
    con.execute(
        "UPDATE blocks SET created_at = MIN("
        "  COALESCE((SELECT created_at FROM pages WHERE pages.id = blocks.page_id),"
        "           updated_at),"
        "  updated_at)"
        " WHERE created_at IS NULL AND updated_at IS NOT NULL")


def _backfill_block_refs(con: sqlite3.Connection) -> None:
    """pkm-d31f: one-time historical catch-up. Blocks written before
    ops_apply maintained block_refs are indexed exactly once, guarded by a
    sync_meta marker rather than "table is empty" -- an empty table is a
    legitimate state for a graph with no ((refs)). Runs inside init_db's
    single commit: a failure aborts startup rather than leaving a
    half-filled index that silently undercounts. The write path owns all
    rows after the marker is set."""
    done = con.execute(
        "SELECT value FROM sync_meta WHERE key = 'block_refs_backfilled'"
    ).fetchone()
    if done is not None and done[0] == "1":
        return
    for uid, text in con.execute("SELECT uid, text FROM blocks"):
        targets = extract(text).block_refs
        if targets:
            con.executemany("INSERT OR IGNORE INTO block_refs VALUES (?,?)",
                            [(uid, t) for t in targets])
    con.execute(
        "INSERT INTO sync_meta(key, value) VALUES ('block_refs_backfilled','1')"
        " ON CONFLICT(key) DO UPDATE SET value = '1'")


def init_db(path: Path) -> None:
    """One-time, idempotent database setup: switch to WAL journal mode and
    apply the base schema. Call this once at process startup (serve
    entrypoints) or from test fixtures, before any connection-per-request
    is opened — never from open_db() itself. Both operations here take
    locks that are incompatible with any other connection's open write
    transaction, so running them per-request (the pre-pkm-lhzd behavior)
    could raise 'database is locked' on an ordinary concurrent request.

    schema.DDL is entirely IF-NOT-EXISTS (pkm-cqu2), and guarded column
    migrations run immediately afterwards, so setup is safe for every
    database this can be pointed at: a brand-new, empty
    data dir (no Roam import ever run -- previously left with zero
    tables, so every page route 500'd with 'no such table: pages'), a
    database the importer already built (same DDL, so this is a no-op),
    and a pre-pkm-lhzd already-populated database missing a table added
    since (e.g. sidebar_entries or blocks.view_type), which picks it up
    with no manual migration step. Then _backfill_created_at() fills any
    NULL blocks.created_at left by old Roam imports (pkm-r7k8); like the
    migrations above it is guarded to be a no-op past the first run.
    _backfill_block_refs() catches up the `((uid))` index once (pkm-d31f),
    guarded by a sync_meta marker."""
    con = sqlite3.connect(path)
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA recursive_triggers=ON")
        con.executescript(DDL)
        _ensure_schema_migrations(con)
        _backfill_created_at(con)
        _backfill_block_refs(con)
        con.commit()
    finally:
        con.close()


def open_db(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA recursive_triggers=ON")
    con.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    return con


def get_config(request: Request) -> Config:
    return request.app.state.config


def get_db(request: Request):
    con = open_db(request.app.state.config.db_path)
    try:
        yield con
    finally:
        con.close()
