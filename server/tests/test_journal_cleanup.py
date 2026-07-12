import sqlite3
from collections.abc import Sequence
from datetime import date, timedelta

from pkm.server.daily import title_for_date


def _insert_page(db_path, page_id: int, title: str,
                 blocks: Sequence[tuple[str, str]] = ()) -> None:
    """blocks: [(uid, text), ...] as top-level blocks of the page."""
    con = sqlite3.connect(db_path)
    con.execute("INSERT INTO pages(id, title) VALUES (?, ?)", (page_id, title))
    con.executemany(
        "INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?)",
        [(uid, page_id, None, i, text, None, 0, None, None)
         for i, (uid, text) in enumerate(blocks)])
    con.commit()
    con.close()


def _page_exists(db_path, title: str) -> bool:
    con = sqlite3.connect(db_path)
    row = con.execute("SELECT 1 FROM pages WHERE title = ?",
                      (title,)).fetchone()
    con.close()
    return row is not None


def _daily_title(days_ago: int) -> str:
    return title_for_date(date.today() - timedelta(days=days_ago))


# conftest seeds this fixed daily title (page id 3, non-blank blocks); tests
# must never insert it themselves -- pages.title is UNIQUE.
SEEDED_DAILY_TITLE = "July 7th, 2026"


def _in_window_days_ago() -> int:
    """An offset inside the cleanup window (1..7 days ago) whose title does
    not collide with the seeded daily page, whatever today's date is."""
    return next(k for k in range(1, 8) if _daily_title(k) != SEEDED_DAILY_TITLE)


def _outside_window_days_ago() -> int:
    """An offset just outside the window, collision-free on any run date."""
    return next(k for k in (8, 9) if _daily_title(k) != SEEDED_DAILY_TITLE)


def test_deletes_zero_block_past_daily(client, seeded_config):
    title = _daily_title(_in_window_days_ago())
    _insert_page(seeded_config.db_path, 90, title)

    r = client.post("/api/journal/cleanup")

    assert r.status_code == 200
    assert r.json() == {"deleted": [title]}
    assert not _page_exists(seeded_config.db_path, title)


def test_deletes_whitespace_only_daily_and_purges_fts(client, seeded_config):
    title = _daily_title(_in_window_days_ago())
    _insert_page(seeded_config.db_path, 91, title,
                 [("uid_w1", "   "), ("uid_w2", "\t")])

    r = client.post("/api/journal/cleanup")

    assert title in r.json()["deleted"]
    assert not _page_exists(seeded_config.db_path, title)
    con = sqlite3.connect(seeded_config.db_path)
    orphans = con.execute(
        "SELECT rowid FROM blocks_fts WHERE rowid NOT IN"
        " (SELECT rowid FROM blocks)").fetchall()
    con.close()
    assert orphans == []  # blocks_fts_ad fired for the deleted blocks


def test_spares_todays_empty_page(client, seeded_config):
    today_title = title_for_date(date.today())
    # the journal endpoint auto-creates today's page
    client.get("/api/journal?days=1")
    assert _page_exists(seeded_config.db_path, today_title)

    r = client.post("/api/journal/cleanup")

    assert today_title not in r.json()["deleted"]
    assert _page_exists(seeded_config.db_path, today_title)


def test_spares_daily_with_content(client, seeded_config):
    title = _daily_title(_in_window_days_ago())
    _insert_page(seeded_config.db_path, 92, title, [("uid_c1", "real note")])

    r = client.post("/api/journal/cleanup")

    assert r.json() == {"deleted": []}
    assert _page_exists(seeded_config.db_path, title)


def test_spares_daily_whose_blank_block_is_referenced(client, seeded_config):
    title = _daily_title(_in_window_days_ago())
    _insert_page(seeded_config.db_path, 93, title, [("uid_r1", "  ")])
    # a block on another page (seeded page id 2, "AI") embeds ((uid_r1))
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?)",
        ("uid_r2", 2, None, 5, "see ((uid_r1))", None, 0, None, None))
    con.commit()
    con.close()

    r = client.post("/api/journal/cleanup")

    assert r.json() == {"deleted": []}
    assert _page_exists(seeded_config.db_path, title)


def test_ignores_empty_daily_older_than_a_week(client, seeded_config):
    title = _daily_title(_outside_window_days_ago())
    _insert_page(seeded_config.db_path, 94, title)

    r = client.post("/api/journal/cleanup")

    assert r.json() == {"deleted": []}
    assert _page_exists(seeded_config.db_path, title)


def test_second_call_is_a_noop(client, seeded_config):
    _insert_page(seeded_config.db_path, 95, _daily_title(_in_window_days_ago()))

    assert client.post("/api/journal/cleanup").json()["deleted"] != []
    assert client.post("/api/journal/cleanup").json() == {"deleted": []}


def test_cleanup_requires_auth(anon_client):
    assert anon_client.post("/api/journal/cleanup").status_code == 401
