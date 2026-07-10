"""Regression tests for pkm-lhzd: open_db() must never perform WAL/DDL
setup, because that requires SQLite locks that collide with any other
connection's open write transaction. See docs/2026-07-10-implementation-
review.md finding 1 for the original Playwright-reproduced traceback."""
import sqlite3
import threading

from pkm.schema import DDL
from pkm.server.db import open_db
from pkm.server.ops_apply import apply_batch
from pkm.server.ops_core import CreateOp, OpBatch

NOW = 1_800_000_000_000


def _fresh_non_wal_db(path) -> None:
    # Mirrors how a brand-new database is created (importer/e2e harness):
    # schema applied, journal_mode not yet switched to WAL. This is the
    # exact state in which the original bug appeared, because switching a
    # database's journal_mode to WAL requires an exclusive lock, and the
    # per-connection open_db() used to attempt that switch on every call.
    con = sqlite3.connect(path)
    con.executescript(DDL)
    con.commit()
    con.close()


def test_open_db_survives_writer_transaction_on_a_fresh_database(tmp_path):
    db_path = tmp_path / "t.sqlite3"
    _fresh_non_wal_db(db_path)

    writer = sqlite3.connect(db_path)
    writer.execute("BEGIN IMMEDIATE")
    writer.execute("UPDATE pages SET updated_at = updated_at")
    try:
        # open_db() must not need to (re)negotiate journal_mode or any
        # other schema-level lock, so it must succeed immediately even
        # though the writer's transaction is still open.
        con = open_db(db_path)
        assert con.execute("SELECT 1").fetchone()[0] == 1
        con.close()
    finally:
        writer.commit()
        writer.close()


def test_concurrent_open_db_calls_survive_an_in_flight_ops_transaction(tmp_path):
    db_path = tmp_path / "t.sqlite3"
    _fresh_non_wal_db(db_path)

    writer = sqlite3.connect(db_path)
    writer.row_factory = sqlite3.Row
    writer.execute("BEGIN IMMEDIATE")
    apply_batch(writer, OpBatch(client_id="writer", ops=[
        CreateOp(op="create", uid="uid_writer1", page_title="P",
                 parent_uid=None, order_idx=0, text="hello"),
    ]), NOW)
    # writer's ops transaction is now open and uncommitted, matching the
    # checklist scenario: other connections opening while an ops
    # transaction commits.

    # 8 readers + the main thread: the main thread's own wait() only
    # returns once every reader has reached the point of executing its
    # SELECT against the real `blocks` table, so readers are proven to
    # overlap the writer's still-open transaction rather than racing past
    # it -- writer.commit() below runs strictly after that rendezvous and
    # after every reader thread has finished.
    barrier = threading.Barrier(9)
    reader_counts: list[int] = []
    errors: list[BaseException] = []
    lock = threading.Lock()

    def open_and_read() -> None:
        try:
            con = open_db(db_path)
            barrier.wait(timeout=5)
            count = con.execute("SELECT COUNT(*) FROM blocks").fetchone()[0]
            con.close()
            with lock:
                reader_counts.append(count)
        except (sqlite3.OperationalError, threading.BrokenBarrierError) as exc:
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=open_and_read) for _ in range(8)]
    for t in threads:
        t.start()
    barrier.wait(timeout=5)  # blocks here until all 8 readers are mid-read
    for t in threads:
        t.join()
    writer.commit()
    writer.close()

    assert not errors, f"open_db()/read raised under writer contention: {errors}"
    # Readers hold a snapshot from before the writer's uncommitted insert:
    # the real table read observes 0 rows, not the writer's pending 1.
    assert reader_counts == [0] * 8
