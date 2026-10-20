from collections.abc import Sequence
from datetime import date, timedelta

from rawread import read
from pkm.contracts.daily import title_for_date
from pkm.database import connect
from pkm.server.store import reindex_refs_for_text
from pkm.test_data.ids import page_id_of, uid_of
from pkm.contracts.ops import BlockUid, PageId


def _insert_page(db_path, page_id: PageId, title_text: str,
                 blocks: Sequence[tuple[str, str]] = ()) -> None:
    """blocks: [(uid, text), ...] as top-level blocks of the page."""
    con = connect(db_path)
    con.execute("INSERT INTO pages(id, title) VALUES (?, ?)", (page_id, title_text))
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        [(uid, page_id, None, i, text, None, 0, None, None)
         for i, (uid, text) in enumerate(blocks)])
    con.commit()
    con.close()


def _insert_indexed_block(db_path, uid: BlockUid, page_id: PageId, text: str) -> None:
    """A top-level block on an existing page, with its refs/block_refs rows
    derived the way the server derives them."""
    con = connect(db_path)
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (uid, page_id, None, 5, text, None, 0, None, None))
    reindex_refs_for_text(con, uid, text, 0)
    con.commit()
    con.close()


def _page_exists(db_path, title_text: str) -> bool:
    con = connect(db_path)
    row = read(con, "SELECT 1 FROM pages WHERE title = ?",
                      (title_text,)).fetchone()
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
    _insert_page(seeded_config.db_path, page_id_of(90), title)

    r = client.post("/api/journal/cleanup")

    assert r.status_code == 200
    assert r.json() == {"deleted": [title]}
    assert not _page_exists(seeded_config.db_path, title)


def test_deletes_whitespace_only_daily_and_purges_fts(client, seeded_config):
    title = _daily_title(_in_window_days_ago())
    _insert_page(seeded_config.db_path, page_id_of(91), title,
                 [("uid_w1", "   "), ("uid_w2", "\t")])

    r = client.post("/api/journal/cleanup")

    assert title in r.json()["deleted"]
    assert not _page_exists(seeded_config.db_path, title)
    con = connect(seeded_config.db_path)
    orphans = read(con,
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
    _insert_page(seeded_config.db_path, page_id_of(92), title, [("uid_c1", "real note")])

    r = client.post("/api/journal/cleanup")

    assert r.json() == {"deleted": []}
    assert _page_exists(seeded_config.db_path, title)


def test_spares_daily_whose_blank_block_is_referenced(client, seeded_config):
    title = _daily_title(_in_window_days_ago())
    _insert_page(seeded_config.db_path, page_id_of(93), title, [("uid_r1", "  ")])
    # a block on another page (seeded page id 2, "AI") embeds ((uid_r1))
    _insert_indexed_block(seeded_config.db_path, uid_of("uid_r2"), page_id_of(2), "see ((uid_r1))")

    r = client.post("/api/journal/cleanup")

    assert r.json() == {"deleted": []}
    assert _page_exists(seeded_config.db_path, title)


def test_spares_empty_daily_with_inbound_link(client, seeded_config):
    title = _daily_title(_in_window_days_ago())
    _insert_page(seeded_config.db_path, page_id_of(97), title)
    _insert_indexed_block(seeded_config.db_path, uid_of("uid_l1"), page_id_of(2), f"see [[{title}]]")

    r = client.post("/api/journal/cleanup")

    assert r.json() == {"deleted": []}
    assert _page_exists(seeded_config.db_path, title)


def test_spares_empty_daily_with_inbound_tag(client, seeded_config):
    title = _daily_title(_in_window_days_ago())
    _insert_page(seeded_config.db_path, page_id_of(98), title)
    _insert_indexed_block(seeded_config.db_path, uid_of("uid_t1"), page_id_of(2), f"x #[[{title}]]")

    r = client.post("/api/journal/cleanup")

    assert r.json() == {"deleted": []}
    assert _page_exists(seeded_config.db_path, title)


def test_spares_empty_daily_with_inbound_attribute(client, seeded_config):
    title = _daily_title(_in_window_days_ago())
    _insert_page(seeded_config.db_path, page_id_of(96), title)
    _insert_indexed_block(seeded_config.db_path, uid_of("uid_a1"), page_id_of(2), f"{title}:: x")

    r = client.post("/api/journal/cleanup")

    assert r.json() == {"deleted": []}
    assert _page_exists(seeded_config.db_path, title)


def test_ignores_empty_daily_older_than_a_week(client, seeded_config):
    title = _daily_title(_outside_window_days_ago())
    _insert_page(seeded_config.db_path, page_id_of(94), title)

    r = client.post("/api/journal/cleanup")

    assert r.json() == {"deleted": []}
    assert _page_exists(seeded_config.db_path, title)


def test_second_call_is_a_noop(client, seeded_config):
    _insert_page(seeded_config.db_path, page_id_of(95), _daily_title(_in_window_days_ago()))

    assert client.post("/api/journal/cleanup").json()["deleted"] != []
    assert client.post("/api/journal/cleanup").json() == {"deleted": []}


def test_cleanup_requires_auth(anon_client):
    assert anon_client.post("/api/journal/cleanup").status_code == 401


def test_cleanup_deletion_emits_seq_nudge(client, seeded_config):
    """Cleanup commits deletions and advances changes.seq; connected
    replicas must be nudged, or they keep showing deleted daily pages
    until some unrelated mutation nudges them."""
    title = _daily_title(_in_window_days_ago())
    _insert_page(seeded_config.db_path, page_id_of(96), title)

    with client.websocket_connect("/api/ws") as ws:
        r = client.post("/api/journal/cleanup")
        assert r.status_code == 200
        assert r.json() == {"deleted": [title]}
        frames = []
        for _ in range(5):
            frames.append(ws.receive_json())
            if frames[-1].get("type") == "seq":
                break
        else:
            raise AssertionError(f"no seq nudge in {frames}")
        assert frames[-1]["seq"] > 0


def test_cleanup_noop_emits_no_seq_nudge(client, seeded_config):
    """A cleanup call that deletes nothing doesn't advance changes.seq, so
    it shouldn't broadcast a nudge either -- distinguishes this fix from a
    blanket "always nudge" that would mask the deleted-rows condition."""
    with client.websocket_connect("/api/ws") as ws:
        r = client.post("/api/journal/cleanup")
        assert r.json() == {"deleted": []}
        # No frame should arrive; send a distinguishable follow-up mutation
        # and confirm ITS nudge is the first frame received.
        client.post("/api/sidebar", json={"title": "Post-Noop-Cleanup"})
        frames = []
        for _ in range(5):
            frames.append(ws.receive_json())
            if frames[-1].get("type") == "seq":
                break
        else:
            raise AssertionError(f"no seq nudge in {frames}")
        assert frames == [{"type": "seq", "seq": frames[-1]["seq"]}]
