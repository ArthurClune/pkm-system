"""page_deletions: user page deletes leave a title + journal seq record that
stale_titles reads back; daily pages and the journal cleanup record nothing."""
from __future__ import annotations

import sqlite3
from datetime import date, timedelta

from pkm.contracts.daily import title_for_date
from pkm.schema import DDL
from pkm.server.store import stale_titles


def _rows(config, sql, params=()):
    con = sqlite3.connect(config.db_path)
    try:
        return con.execute(sql, params).fetchall()
    finally:
        con.close()


def test_delete_records_title_and_seq(client, seeded_config):
    assert client.delete("/api/page/Machine Learning").status_code == 200
    rows = _rows(seeded_config, "SELECT title, seq FROM page_deletions")
    latest = _rows(seeded_config, "SELECT MAX(seq) FROM changes")[0][0]
    assert rows == [("Machine Learning", latest)]


def test_daily_page_delete_is_not_recorded(client, seeded_config):
    assert client.delete("/api/page/July 7th, 2026").status_code == 200
    assert _rows(seeded_config, "SELECT * FROM page_deletions") == []


def test_cleanup_journal_does_not_record(client, seeded_config):
    title = title_for_date(date.today() - timedelta(days=2))
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO pages(title, created_at, updated_at)"
                " VALUES (?, 1, 1)", (title,))
    con.commit()
    con.close()
    r = client.post("/api/journal/cleanup")
    assert r.status_code == 200
    assert title in r.json()["deleted"]
    assert _rows(seeded_config, "SELECT * FROM page_deletions") == []


def test_rows_past_retention_are_pruned(client, seeded_config):
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO page_deletions VALUES ('Old', 1, 1)")
    con.commit()
    con.close()
    assert client.delete("/api/page/Machine Learning").status_code == 200
    titles = [r[0] for r in _rows(seeded_config,
                                  "SELECT title FROM page_deletions")]
    assert titles == ["Machine Learning"]


def test_stale_titles():
    db = sqlite3.connect(":memory:")
    db.executescript(DDL)
    db.executemany("INSERT INTO page_deletions VALUES (?,?,0)",
                   [("A", 10), ("B", 20)])
    db.execute("INSERT INTO changes(seq, kind, entity_id) VALUES (25,'page','x')")
    assert stale_titles(db, None) == frozenset()
    assert stale_titles(db, 10) == {"B"}
    assert stale_titles(db, 9) == {"A", "B"}
    assert stale_titles(db, 20) == frozenset()
    assert stale_titles(db, 26) == {"A", "B"}
