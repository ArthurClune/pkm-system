"""Store-level page delete: inbound links unlink, block refs inline."""
from __future__ import annotations

import pytest

from pkm.contracts.ops import PageId, text_hash
from pkm.refs import CanonicalTitle, normalize_title
from pkm.server.db import open_db
from pkm.server.store import (DeleteBlockedError, delete_page_unlinking,
                              plan_delete, reindex_refs_for_text)

NOW = 5_000_000_000_000
TITLE = CanonicalTitle(normalize_title("Machine Learning"))


@pytest.fixture()
def db(seeded_config):
    con = open_db(seeded_config.db_path)
    yield con
    con.close()


def _text(db, uid):
    return db.execute("SELECT text FROM blocks WHERE uid = ?",
                      (uid,)).fetchone()["text"]


def _add_block(db, uid, text, page_id=3, order=9):
    db.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " collapsed) VALUES (?,?,NULL,?,?,0)", (uid, page_id, order, text))
    reindex_refs_for_text(db, uid, text, NOW)


def test_delete_unlinks_inbound_links(db):
    delete_page_unlinking(db, PageId(1), TITLE, NOW)
    assert _text(db, "uid_b4") == "Studying Machine Learning today"
    assert db.execute(
        "SELECT count(*) FROM refs r JOIN pages p ON p.id = r.target_page_id"
        " WHERE p.title = ?", (TITLE,)).fetchone()[0] == 0
    assert db.execute("SELECT 1 FROM pages WHERE id = 1").fetchone() is None


def test_delete_inlines_block_refs(db):
    delete_page_unlinking(db, PageId(1), TITLE, NOW)
    assert _text(db, "uid_b5") == (
        "See [[Attention Is All You Need]] is a [[Paper]] for details")
    assert db.execute("SELECT count(*) FROM block_refs WHERE src_block_uid ="
                      " 'uid_b5'").fetchone()[0] == 0
    titles = {r[0] for r in db.execute(
        "SELECT p.title FROM refs r JOIN pages p ON p.id = r.target_page_id"
        " WHERE r.src_block_uid = 'uid_b5'")}
    assert "Paper" in titles


def test_delete_block_with_link_and_ref_is_rewritten_once(db):
    _add_block(db, "uid_x", "[[Machine Learning]] ((uid_b3))")
    delete_page_unlinking(db, PageId(1), TITLE, NOW)
    assert _text(db, "uid_x") == (
        "Machine Learning [[Attention Is All You Need]] is a [[Paper]]")
    pairs = db.execute(
        "SELECT DISTINCT base_hash, after_hash FROM block_rewrites"
        " WHERE uid = 'uid_x'").fetchall()
    assert len(pairs) == 1
    kinds = {r[0] for r in db.execute(
        "SELECT kind FROM block_rewrites WHERE uid = 'uid_x'")}
    assert kinds == {"unlink", "inline"}


def test_delete_records_replay_rows(db):
    before4, before5 = _text(db, "uid_b4"), _text(db, "uid_b5")
    delete_page_unlinking(db, PageId(1), TITLE, NOW)
    unlink = db.execute(
        "SELECT * FROM block_rewrites WHERE uid = 'uid_b4'").fetchall()
    assert [(r["kind"], r["old_title"], r["new_title"]) for r in unlink] == [
        ("unlink", TITLE, "")]
    assert unlink[0]["base_hash"] == text_hash(before4)
    assert unlink[0]["after_hash"] == text_hash(_text(db, "uid_b4"))
    inline = db.execute(
        "SELECT * FROM block_rewrites WHERE uid = 'uid_b5'").fetchall()
    assert [(r["kind"], r["old_title"]) for r in inline] == [
        ("inline", "uid_b3")]
    assert inline[0]["new_title"] == (
        "[[Attention Is All You Need]] is a [[Paper]]")
    assert inline[0]["base_hash"] == text_hash(before5)
    assert inline[0]["after_hash"] == text_hash(_text(db, "uid_b5"))


def test_delete_refused_by_query_blocker(db):
    query = "{{query: {and: [[Machine Learning]]}}}"
    _add_block(db, "uid_q", query)
    before = _text(db, "uid_b4")
    with pytest.raises(DeleteBlockedError) as err:
        delete_page_unlinking(db, PageId(1), TITLE, NOW)
    assert [(b.uid, b.reason) for b in err.value.blockers] == [
        ("uid_q", "query")]
    assert db.execute("SELECT 1 FROM pages WHERE id = 1").fetchone()
    assert _text(db, "uid_b4") == before
    assert _text(db, "uid_q") == query
    assert db.execute("SELECT count(*) FROM block_rewrites").fetchone()[0] == 0


def test_delete_without_inbound_refs_only_deletes(db):
    db.execute("INSERT INTO pages(id, title) VALUES (9, 'Lonely')")
    plan = plan_delete(db, PageId(9), CanonicalTitle(normalize_title("Lonely")))
    assert plan.rewrites == {} and plan.blockers == ()
    texts = {r["uid"]: r["text"] for r in db.execute(
        "SELECT uid, text FROM blocks WHERE page_id != 9")}
    delete_page_unlinking(db, PageId(9), CanonicalTitle(normalize_title("Lonely")), NOW)
    assert db.execute("SELECT 1 FROM pages WHERE id = 9").fetchone() is None
    assert texts == {r["uid"]: r["text"] for r in db.execute(
        "SELECT uid, text FROM blocks")}
    assert db.execute("SELECT count(*) FROM block_rewrites").fetchone()[0] == 0
