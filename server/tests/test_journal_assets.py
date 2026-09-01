import hashlib
from datetime import date

import sqlite3

from pkm.contracts.daily import title_for_date
from pkm.server.routes_pages import JOURNAL_BACKLINK_PREVIEW


def test_journal_includes_seeded_daily(client):
    # seeded daily page: July 7th, 2026. Empty days are omitted (pkm-03x6):
    # the batch holds only non-empty dailies, so July 6th is not a filler row.
    r = client.get("/api/journal",
                   params={"before": "2026-07-08", "days": 2})
    assert r.status_code == 200
    days = r.json()["days"]
    assert [d["date"] for d in days] == ["2026-07-07"]
    assert days[0]["title"] == "July 7th, 2026"
    assert days[0]["exists"] is True
    assert [b["text"] for b in days[0]["blocks"]] == \
        ["Studying [[Machine Learning]] today", "See ((uid_b3)) for details"]


def test_journal_resolves_block_refs(client):
    # uid_b5 on the July 7th page reads "See ((uid_b3)) for details" — the
    # journal payload must carry the texts to render it, like /api/page does.
    r = client.get("/api/journal",
                   params={"before": "2026-07-08", "days": 2})
    assert r.status_code == 200
    assert r.json()["block_ref_texts"] == {
        "uid_b3": {"text": "[[Attention Is All You Need]] is a [[Paper]]",
                   "page_title": "Machine Learning"}}


def test_journal_auto_creates_today_only(client, seeded_config):
    today = date.today()
    con = sqlite3.connect(seeded_config.db_path)
    before = {r[0] for r in con.execute("SELECT title FROM pages")}
    con.close()
    r = client.get("/api/journal", params={"days": 3})
    days = r.json()["days"]
    assert days[0]["date"] == today.isoformat()
    con = sqlite3.connect(seeded_config.db_path)
    after = {r[0] for r in con.execute("SELECT title FROM pages")}
    con.close()
    assert title_for_date(today) in after
    assert after - before == {title_for_date(today)}


def test_journal_head_is_today_plus_recent_nonempty_days(client):
    # The head batch reaches back to the most recent non-empty dailies —
    # July 7th, 2026 from the seed — instead of listing empty calendar days.
    r = client.get("/api/journal", params={"days": 3})
    days = r.json()["days"]
    assert [d["date"] for d in days] == [date.today().isoformat(),
                                         "2026-07-07"]
    assert all(d["exists"] for d in days)


def _add_daily(db_path, page_id, title, texts):
    con = sqlite3.connect(db_path)
    con.execute("INSERT INTO pages VALUES (?,?,NULL,NULL)", (page_id, title))
    for i, text in enumerate(texts):
        con.execute(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " heading, collapsed, created_at, updated_at)"
            " VALUES (?,?,NULL,?,?,NULL,0,NULL,NULL)",
            (f"uid_{page_id}_{i}", page_id, i, text))
    con.commit()
    con.close()


def test_journal_skips_whitespace_only_dailies(client, seeded_config):
    _add_daily(seeded_config.db_path, 90, "July 5th, 2026", [" ", "\t\n"])
    _add_daily(seeded_config.db_path, 91, "July 3rd, 2026", ["real entry"])
    r = client.get("/api/journal",
                   params={"before": "2026-07-08", "days": 2})
    days = r.json()["days"]
    assert [d["date"] for d in days] == ["2026-07-07", "2026-07-03"]


def test_journal_cursor_pages_through_nonempty_days_until_exhausted(
        client, seeded_config):
    _add_daily(seeded_config.db_path, 92, "June 20th, 2026", ["older entry"])
    r = client.get("/api/journal",
                   params={"before": "2026-07-07", "days": 5})
    days = r.json()["days"]
    # fewer than requested signals exhaustion to the client
    assert [d["date"] for d in days] == ["2026-06-20"]
    assert [b["text"] for b in days[0]["blocks"]] == ["older entry"]


def test_journal_surfaces_an_empty_day_referenced_from_elsewhere(
        client, seeded_config):
    # pkm-vvta: a daily page with zero blocks would normally be invisible
    # (only non-empty days show, and it isn't "today"). A [[link]] from
    # another page's block still means it has something worth surfacing --
    # linked references -- so it counts as non-empty too.
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO pages VALUES (?,?,NULL,NULL)", (90, "July 5th, 2026"))
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,NULL,0,?,NULL,0,NULL,NULL)",
        ("uid_ref5", 1, "Remind me on [[July 5th, 2026]] to check this"))
    con.execute("INSERT INTO refs VALUES (?,?,?)", ("uid_ref5", 90, "link"))
    con.commit()
    con.close()
    r = client.get("/api/journal",
                   params={"before": "2026-07-08", "days": 5})
    days = r.json()["days"]
    assert [d["date"] for d in days] == ["2026-07-07", "2026-07-05"]
    day = days[1]
    assert day["title"] == "July 5th, 2026"
    assert day["exists"] is True
    assert day["blocks"] == []
    # ...and it arrives WITH those references (pkm-5fak): the day renders
    # from this payload alone, so a scroll of N days is not N page reads.
    assert day["backlinks"]["total_pages"] == 1
    assert [(g["page_title"], [i["text"] for i in g["items"]])
            for g in day["backlinks"]["groups"]] == [
        ("Machine Learning",
         ["Remind me on [[July 5th, 2026]] to check this"])]


def test_journal_day_backlinks_carry_their_own_block_ref_texts(
        client, seeded_config):
    # A referencing block may itself embed ((uid)). The journal merges those
    # texts into the payload's one block_ref_texts map, so the day's inline
    # references resolve without the per-day page read they used to make
    # (pkm-5fak).
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO pages VALUES (?,?,NULL,NULL)", (91, "July 4th, 2026"))
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,NULL,0,?,NULL,0,NULL,NULL)",
        ("uid_ref4", 1, "On [[July 4th, 2026]] see ((uid_b3))"))
    con.execute("INSERT INTO refs VALUES (?,?,?)", ("uid_ref4", 91, "link"))
    con.commit()
    con.close()
    r = client.get("/api/journal", params={"before": "2026-07-05", "days": 5})
    body = r.json()
    day = next(d for d in body["days"] if d["date"] == "2026-07-04")
    assert day["blocks"] == []  # the ref text comes from the backlink, not a block
    assert body["block_ref_texts"]["uid_b3"]["page_title"] == "Machine Learning"


def test_journal_day_backlinks_are_a_preview_page(client, seeded_config):
    # Each day carries JOURNAL_BACKLINK_PREVIEW referencing pages and states
    # that limit, so the client's "Show more" pages the rest from /api/page.
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO pages VALUES (?,?,NULL,NULL)", (95, "July 3rd, 2026"))
    for n in range(7):
        con.execute("INSERT INTO pages VALUES (?,?,?,NULL)",
                    (100 + n, f"Referrer {n}", 1000 + n))
        con.execute(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " heading, collapsed, created_at, updated_at)"
            " VALUES (?,?,NULL,0,?,NULL,0,NULL,NULL)",
            (f"uid_r{n}", 100 + n, "See [[July 3rd, 2026]]"))
        con.execute("INSERT INTO refs VALUES (?,?,?)", (f"uid_r{n}", 95, "link"))
    con.commit()
    con.close()
    r = client.get("/api/journal", params={"before": "2026-07-04", "days": 5})
    day = next(d for d in r.json()["days"] if d["date"] == "2026-07-03")
    assert day["backlinks"]["total_pages"] == 7
    assert len(day["backlinks"]["groups"]) == JOURNAL_BACKLINK_PREVIEW
    assert day["backlinks"]["offset"] == 0
    assert day["backlinks"]["limit"] == JOURNAL_BACKLINK_PREVIEW


def test_journal_does_not_surface_an_unreferenced_empty_day(
        client, seeded_config):
    # Sanity check for the fixture above: a bare empty daily page (no
    # blocks, no inbound refs) still stays hidden.
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO pages VALUES (?,?,NULL,NULL)", (91, "July 6th, 2026"))
    con.commit()
    con.close()
    r = client.get("/api/journal",
                   params={"before": "2026-07-08", "days": 5})
    days = r.json()["days"]
    assert [d["date"] for d in days] == ["2026-07-07"]


def test_asset_serving(client, seeded_config):
    data = b"PNGDATA"
    sha = hashlib.sha256(data).hexdigest()
    dest = seeded_config.assets_dir / sha[:2] / sha
    dest.parent.mkdir(parents=True)
    dest.write_bytes(data)
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO assets(sha256, filename, mime, size, created_at)"
                " VALUES (?,?,?,?,NULL)",
                (sha, "fig.png", "image/png", len(data)))
    con.commit()
    con.close()
    r = client.get(f"/assets/{sha}/fig.png")
    assert r.status_code == 200
    assert r.content == data
    assert r.headers["content-type"] == "image/png"
    assert "immutable" in r.headers["cache-control"]


def test_asset_unknown_sha_404(client):
    assert client.get(f"/assets/{'0' * 64}/x.png").status_code == 404


def test_asset_requires_auth(anon_client):
    assert anon_client.get(f"/assets/{'0' * 64}/x.png").status_code == 401


def test_journal_bad_before_400(client):
    r = client.get("/api/journal", params={"before": "garbage"})
    assert r.status_code == 400
