"""pkm-r7k8: init_db() backfills NULL blocks.created_at from the block's
page, guarded so it never mints a created_at greater than the block's own
updated_at (merged/moved blocks can sit on pages younger than their last
edit) and never writes NULL back. Re-running init_db() must be a no-op
(the backfill is a plain UPDATE ... WHERE created_at IS NULL)."""
import sqlite3

from pkm.schema import DDL
from pkm.server.db import init_db


def _bare_db(path) -> None:
    # Mirrors a database before init_db() has ever run against it (importer
    # output or a hand-built fixture): schema applied, backfill not yet run.
    con = sqlite3.connect(path)
    con.executescript(DDL)
    con.commit()
    con.close()


def _seed(path, pages, blocks) -> None:
    con = sqlite3.connect(path)
    con.executemany("INSERT INTO pages VALUES (?,?,?,?)", pages)
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)", blocks)
    con.commit()
    con.close()


def _created_at(path, uid) -> int | None:
    con = sqlite3.connect(path)
    row = con.execute("SELECT created_at FROM blocks WHERE uid = ?",
                      (uid,)).fetchone()
    con.close()
    return row[0]


def test_backfill_takes_the_pages_created_at_when_it_is_older(tmp_path):
    db_path = tmp_path / "t.sqlite3"
    _bare_db(db_path)
    _seed(db_path,
          pages=[(1, "PageA", 1_000, 5_000)],
          blocks=[("b1", 1, None, 0, "text", None, 0, None, 5_000)])

    init_db(db_path)

    assert _created_at(db_path, "b1") == 1_000


def test_backfill_falls_back_to_the_blocks_own_updated_at_when_page_is_newer(
        tmp_path):
    # MIN() guard: a block merged/moved onto a page created after the block
    # was last edited must not get a created_at > its own updated_at.
    db_path = tmp_path / "t.sqlite3"
    _bare_db(db_path)
    _seed(db_path,
          pages=[(1, "PageB", 9_000, 9_000)],
          blocks=[("b1", 1, None, 0, "text", None, 0, None, 3_000)])

    init_db(db_path)

    # the block's own updated_at, not the page's 9_000: a backfilled
    # created_at must never postdate the block's last edit.
    assert _created_at(db_path, "b1") == 3_000


def test_backfill_falls_back_to_updated_at_when_page_created_at_is_null(
        tmp_path):
    db_path = tmp_path / "t.sqlite3"
    _bare_db(db_path)
    _seed(db_path,
          pages=[(1, "PageC", None, None)],
          blocks=[("b1", 1, None, 0, "text", None, 0, None, 4_000)])

    init_db(db_path)

    assert _created_at(db_path, "b1") == 4_000  # never left as/garbage NULL


def test_backfill_leaves_a_block_with_no_usable_timestamp_alone(tmp_path):
    # The documented limit of the `updated_at IS NOT NULL` guard: with
    # neither a page created_at nor an updated_at there is nothing honest to
    # write, so the row keeps its NULL rather than being given a made-up date.
    db_path = tmp_path / "t.sqlite3"
    _bare_db(db_path)
    _seed(db_path,
          pages=[(1, "PageD", None, None)],
          blocks=[("b1", 1, None, 0, "text", None, 0, None, None)])

    init_db(db_path)

    assert _created_at(db_path, "b1") is None


def test_backfill_is_idempotent_and_leaves_existing_values_alone(tmp_path):
    db_path = tmp_path / "t.sqlite3"
    _bare_db(db_path)
    _seed(db_path,
          pages=[(1, "PageA", 1_000, 5_000)],
          blocks=[
              ("b1", 1, None, 0, "text", None, 0, None, 5_000),
              ("b2", 1, None, 1, "already set", None, 0, 2_000, 8_000),
          ])

    init_db(db_path)  # first pass: b1 backfilled, b2 untouched (not NULL)
    first_pass = (_created_at(db_path, "b1"), _created_at(db_path, "b2"))
    assert first_pass == (1_000, 2_000)

    init_db(db_path)  # second pass: plain UPDATE ... WHERE created_at IS NULL
    assert (_created_at(db_path, "b1"), _created_at(db_path, "b2")) == first_pass
