"""pkm-ldqx: hydration must not run one SQL statement per changed entity.
A legal 5,000-entity window (or an unbounded snapshot) previously ran one
block query plus one refs query per uid -- 10,000+ statements inside a
single read transaction. These tests seed a bulk window/snapshot spanning
multiple chunk boundaries and assert the executed-statement count is
bounded by chunk count, not by entity count."""
import math

from pkm.server.db import open_db
from pkm.server.routes_sync import sync_changes, sync_snapshot
from pkm.server.sync_core import CHUNK_SIZE

# spans 3 chunks so chunking (not just "fits in one query") is exercised
BULK_N = CHUNK_SIZE * 2 + 200


def _seed_bulk(con, n, page_id=1, target_page_id=4):
    rows = [(f"uid_bulk_{i}", page_id, None, 1000 + i,
              f"bulk block {i} refs [[Paper]]", None, 0, None, None)
             for i in range(n)]
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)", rows)
    con.executemany(
        "INSERT INTO refs VALUES (?,?,?)",
        [(f"uid_bulk_{i}", target_page_id, "link") for i in range(n)])
    con.commit()


def _traced(con, fn):
    queries: list[str] = []
    con.set_trace_callback(lambda sql: queries.append(sql))
    try:
        return fn(), queries
    finally:
        con.set_trace_callback(None)


def test_changes_feed_query_count_bounded_by_chunks_not_entities(seeded_config):
    con = open_db(seeded_config.db_path)
    _seed_bulk(con, BULK_N)

    payload, queries = _traced(
        con, lambda: sync_changes(since=0, limit=5000, db=con))

    assert len(payload.blocks) == con.execute(
        "SELECT count(*) FROM blocks").fetchone()[0]
    expected_chunks = math.ceil(
        len(payload.blocks) / CHUNK_SIZE)
    # old N+1 hydration issued ~2 statements per uid here (~2400+ for
    # BULK_N=1200); batched hydration issues a small, chunk-bounded count.
    assert len(queries) < 4 * expected_chunks + 10
    con.close()


def test_snapshot_query_count_bounded_by_chunks_not_entities(seeded_config):
    con = open_db(seeded_config.db_path)
    _seed_bulk(con, BULK_N)

    payload, queries = _traced(con, lambda: sync_snapshot(db=con))

    assert len(payload.blocks) == con.execute(
        "SELECT count(*) FROM blocks").fetchone()[0]
    expected_chunks = math.ceil(len(payload.blocks) / CHUNK_SIZE)
    assert len(queries) < 4 * expected_chunks + 10
    con.close()
