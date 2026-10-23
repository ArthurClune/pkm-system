"""IN-lists built from an unbounded id set stay under SQLite's bound-variable
limit (32,766 on modern builds): the routes answer instead of raising."""
import pytest
from pkm.server.db import open_db
from pkm.test_data.ids import uid_of
from pkm.server.routes_export import _gather_resolution_data
from pkm.server.routes_pages import (
    _block_ref_counts, _fetch_ancestors, _resolve_ref_uids)

N = 33_000  # past 32,766


@pytest.fixture()
def db(seeded_config):
    con = open_db(seeded_config.db_path)
    yield con
    con.close()


def _add_blocks(db, page, prefix, text, n=N, parent=None):
    db.execute("INSERT INTO pages(id, title) VALUES (?, ?)",
               (page, f"P{page}"))
    db.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)"
        " VALUES (?,?,?,?,?)",
        [(f"{prefix}{i:07d}", page, parent, i, text) for i in range(n)])


def test_block_ref_counts_past_the_variable_limit(db):
    _add_blocks(db, 200, "big_", "x")
    _add_blocks(db, 201, "ref_", "see ((big_0000001))")
    db.executemany("INSERT INTO block_refs VALUES (?,?)",
                   [(f"ref_{i:07d}", "big_0000001") for i in range(N)])
    db.commit()
    uids = [uid_of(f"big_{i:07d}") for i in range(N)]
    assert _block_ref_counts(db, uids) == {uid_of("big_0000001"): N}


def test_fetch_ancestors_past_the_variable_limit(db):
    db.execute("INSERT INTO pages(id, title) VALUES (300, 'Tree')")
    db.execute("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)"
               " VALUES ('root_0000000', 300, NULL, 0, 'root')")
    db.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)"
        " VALUES (?,?,?,?,?)",
        [(f"kid_{i:07d}", 300, "root_0000000", i, "k") for i in range(N)])
    db.commit()
    uids = [uid_of(f"kid_{i:07d}") for i in range(N)]
    out = _fetch_ancestors(db, uids)
    assert len(out) == N
    assert out[uids[0]] == ["root"] and out[uids[-1]] == ["root"]
    # a repeated uid must not double its breadcrumb
    assert _fetch_ancestors(db, [uids[0], uids[0]])[uids[0]] == ["root"]


def test_resolve_ref_uids_past_the_variable_limit(db):
    _add_blocks(db, 400, "tgt_", "t")
    db.commit()
    uids = [uid_of(f"tgt_{i:07d}") for i in range(N)]
    out = _resolve_ref_uids(db, uids)
    assert len(out) == N and out[uids[-1]].text == "t"


def test_export_resolution_past_the_variable_limit(db):
    _add_blocks(db, 500, "r", "t")
    db.commit()
    text = " ".join(f"((r{i:07d}))" for i in range(N))
    uid_to_text, _ = _gather_resolution_data(db, [text])
    assert len(uid_to_text) == N


def test_export_route_with_many_refs(client, seeded_config):
    con = open_db(seeded_config.db_path)
    _add_blocks(con, 600, "r", "t", n=100)
    con.execute("INSERT INTO pages(id, title) VALUES (601, 'ManyRefs')")
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)"
        " VALUES ('many_refs0', 601, NULL, 0, ?)",
        (" ".join(f"((r{i:07d}))" for i in range(100)) + " "
         + " ".join(f"((m{i:07d}))" for i in range(N)),))
    con.commit()
    con.close()
    assert client.get("/api/export/page/ManyRefs").status_code == 200


def test_page_and_backlinks_routes_with_huge_pages(client, seeded_config):
    con = open_db(seeded_config.db_path)
    _add_blocks(con, 200, "big_", "x")
    _add_blocks(con, 201, "ref_", "see ((uid_b3))")
    con.executemany("INSERT INTO block_refs VALUES (?,?)",
                    [(f"ref_{i:07d}", "uid_b3") for i in range(N)])
    con.commit()
    con.close()
    assert client.get("/api/page/P200").status_code == 200
    assert client.get("/api/block/uid_b3/backlinks").status_code == 200
    assert client.get("/api/page/P201").status_code == 200
