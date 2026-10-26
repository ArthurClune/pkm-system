"""IN-lists built from an unbounded id set stay under SQLite's bound-variable
limit: the routes answer instead of raising.

Every request connection is capped at LIMIT variables. LIMIT is above the
500-id chunk of `chunk_ids` and below N, so a chunked statement fits and an
unchunked one over N ids trips, without inserting tens of thousands of
rows."""
import sqlite3
from datetime import date

import pytest
from pkm.server import db as server_db
from pkm.server.db import open_db
from pkm.server.routes_pages import _daily_title

LIMIT = 600
N = 700  # past LIMIT, and past one 500-id chunk


@pytest.fixture(autouse=True)
def capped_request_connections(monkeypatch):
    real = server_db.open_db

    def capped(path):
        con = real(path)
        con.raw.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, LIMIT)
        return con

    monkeypatch.setattr(server_db, "open_db", capped)


@pytest.fixture()
def db(seeded_config):
    con = open_db(seeded_config.db_path)
    yield con
    con.close()


def _page(db, page: int, name: str) -> None:
    db.execute("INSERT INTO pages(id, title) VALUES (?, ?)", (page, name))


def _blocks(db, page: int, rows) -> None:
    """rows: (uid, parent_uid, text) in order."""
    db.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)"
        " VALUES (?,?,?,?,?)",
        [(uid, page, parent, i, text)
         for i, (uid, parent, text) in enumerate(rows)])


def _referrers(db, page: int, target: str) -> None:
    """Page `page` holds N children of a root, each ((target))-ing a block."""
    _page(db, page, f"P{page}")
    _blocks(db, page, [("root_0000000", None, "root")] + [
        (f"ref_{i:07d}", "root_0000000", f"see (({target}))")
        for i in range(N)])
    db.executemany("INSERT INTO block_refs VALUES (?,?)",
                   [(f"ref_{i:07d}", target) for i in range(N)])


def test_page_counts_refs_to_each_of_many_blocks(client, db):
    _page(db, 200, "Big")
    _blocks(db, 200, [(f"big_{i:07d}", None, "x") for i in range(N)])
    _referrers(db, 201, "big_0000001")
    db.commit()
    body = client.get("/api/page/Big").json()
    assert body["block_ref_counts"] == {"big_0000001": N}


def test_block_backlinks_carry_breadcrumbs_for_every_referrer(client, db):
    _referrers(db, 201, "uid_b3")
    db.commit()
    groups = client.get("/api/block/uid_b3/backlinks").json()["groups"]
    trails = [[g["ancestor_texts"][a] for a in i["ancestors"]]
              for g in groups for i in g["items"]
              if i["uid"].startswith("ref_")]
    assert len(trails) == N
    assert all(trail == ["root"] for trail in trails)


def test_page_with_many_referrers_resolves_refs_and_backlinks(client, db):
    _referrers(db, 201, "uid_b3")
    db.commit()
    body = client.get("/api/page/P201").json()
    assert "uid_b3" in body["block_ref_texts"]
    assert len(body["blocks"][0]["children"]) == N


def test_block_with_many_distinct_refs_resolves_all_of_them(client, db):
    _page(db, 400, "Targets")
    _blocks(db, 400, [(f"tgt_{i:07d}", None, f"t{i}") for i in range(N)])
    _page(db, 401, "Holder")
    _blocks(db, 401, [("holder_0000", None, " ".join(
        f"((tgt_{i:07d}))" for i in range(N)))])
    db.commit()
    texts = client.get("/api/page/Holder").json()["block_ref_texts"]
    assert len(texts) == N and texts["tgt_0000699"]["text"] == "t699"
    assert len(client.get(
        "/api/block/holder_0000").json()["block_ref_texts"]) == N


def test_export_resolves_many_distinct_refs(client, db):
    _page(db, 400, "Targets")
    _blocks(db, 400, [(f"tgt_{i:07d}", None, f"t{i}") for i in range(N)])
    _page(db, 401, "ManyRefs")
    _blocks(db, 401, [("holder_0000", None, " ".join(
        f"((tgt_{i:07d}))" for i in range(N)))])
    db.commit()
    r = client.get("/api/export/page/ManyRefs")
    assert r.status_code == 200
    assert "t699" in r.text and "((tgt_" not in r.text


def test_journal_counts_and_resolves_past_the_limit(client, db):
    client.get("/api/journal")  # creates today's page
    today = db.select_one("SELECT id AS page_id FROM pages WHERE title = ?",
                          (_daily_title(date.today()),))
    assert today is not None
    _blocks(db, today["page_id"],
            [(f"day_{i:07d}", None, "x") for i in range(N)])
    _referrers(db, 201, "day_0000002")
    db.commit()
    body = client.get("/api/journal").json()
    assert body["block_ref_counts"] == {"day_0000002": N}


def test_breadcrumb_is_not_doubled_when_a_block_straddles_chunks(client, db):
    """One block linking a page as [[X]] and #X has two refs rows, so it
    occurs twice in the backlink rows; at a chunk boundary the two copies
    land in different chunks unless the uids are deduped first."""
    _page(db, 300, "Target")
    _page(db, 301, "Src")
    kids = [(f"kid_{i:07d}", "root_0000000", "k") for i in range(501)]
    _blocks(db, 301, [("root_0000000", None, "root")] + kids)
    db.executemany("INSERT INTO refs VALUES (?,?,?)",
                   [(uid, 300, "link") for uid, *_ in kids]
                   + [("kid_0000499", 300, "tag")])
    db.commit()
    groups = client.get("/api/page/Target").json()["backlinks"]["groups"]
    [group] = groups
    items = {i["uid"]: i for i in group["items"]}
    assert len(items) == 501
    assert group["ancestor_texts"] == ["root"]
    assert items["kid_0000499"]["ancestors"] == [0]
    assert items["kid_0000500"]["ancestors"] == [0]
