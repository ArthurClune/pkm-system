import sqlite3

import pytest
from pkm.schema import DDL
from pkm.server.auth_core import YEAR_MS, sign_session, verify_session
from pkm.server.db import init_db, open_db
from pkm.server.store import fetch_page, get_or_create_page

SECRET = b"s" * 32
NOW = 1_700_000_000_000


def test_session_expiry_and_skew():
    token = sign_session(SECRET, NOW)
    assert verify_session(SECRET, token, now_ms=NOW + 1000)
    assert verify_session(SECRET, token, now_ms=NOW + YEAR_MS)          # boundary ok
    assert not verify_session(SECRET, token, now_ms=NOW + YEAR_MS + 1)  # expired
    assert not verify_session(SECRET, token, now_ms=NOW - 6 * 60 * 1000)  # future
    assert verify_session(SECRET, token, now_ms=NOW - 4 * 60 * 1000)      # skew ok
    bad = f"v1.notanumber.{token.split('.')[2]}"
    assert not verify_session(SECRET, bad, now_ms=NOW)


def _db(tmp_path) -> sqlite3.Connection:
    path = tmp_path / "t.sqlite3"
    init_db(path)
    con = open_db(path)
    con.executescript(DDL)
    return con


def test_get_or_create_page(tmp_path):
    db = _db(tmp_path)
    page = get_or_create_page(db, "New Page", 123)
    assert page["title"] == "New Page" and page["created_at"] == 123
    again = get_or_create_page(db, "New Page", 456)
    assert again["id"] == page["id"] and again["created_at"] == 123
    assert db.in_transaction  # helper must NOT have committed
    db.rollback()
    assert fetch_page(db, "New Page") is None  # rollback undid the create
    db.close()


def _seed_linear_chain(
    db_path,
    *,
    page_id: int,
    page_title: str,
    ancestor_count: int,
    prefix: str,
) -> tuple[str, list[str]]:
    con = open_db(db_path)
    con.execute(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (page_id, page_title, None, None),
    )
    blocks = []
    parent_uid = None
    for idx in range(ancestor_count + 1):
        uid = f"{prefix}_{idx:03d}"
        blocks.append((
            uid,
            page_id,
            parent_uid,
            idx,
            f"{prefix} text {idx}",
            None,
            0,
            None,
            None,
        ))
        parent_uid = uid
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        blocks,
    )
    con.commit()
    con.close()
    assert parent_uid is not None
    return parent_uid, [f"{prefix} text {idx}" for idx in range(ancestor_count)]


@pytest.mark.parametrize("ancestor_count", [100, 101, 102, 150])
def test_block_ancestor_breadcrumbs_are_complete_for_deep_linear_chain(
        client, seeded_config, ancestor_count):
    leaf_uid, expected = _seed_linear_chain(
        seeded_config.db_path,
        page_id=99,
        page_title=f"Deep Chain {ancestor_count}",
        ancestor_count=ancestor_count,
        prefix=f"chain{ancestor_count}",
    )

    r = client.get(f"/api/block/{leaf_uid}")

    assert r.status_code == 200
    body = r.json()
    assert body["block"]["uid"] == leaf_uid
    assert body["breadcrumbs"] == expected


def test_ancestor_reads_stop_on_exact_cycle(client, seeded_config):
    # Manufacture a parent cycle directly (ops will forbid these, but reads
    # must not hang if one ever appears).
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("UPDATE blocks SET parent_uid = 'uid_b3' WHERE uid = 'uid_b2'")
    con.commit()
    con.close()

    body = client.get("/api/page/Paper").json()
    [group] = body["backlinks"]["groups"]
    [item] = group["items"]

    assert item["uid"] == "uid_b3"
    assert item["breadcrumbs"] == ["Papers"]
    assert item["text"] not in item["breadcrumbs"]
