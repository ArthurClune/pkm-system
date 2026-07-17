import sqlite3


def _rename(client, title, new_title, allow_merge=False):
    return client.post(f"/api/page/{title}/rename",
                       json={"new_title": new_title,
                             "allow_merge": allow_merge})


def test_rename_updates_title_and_referencing_text(client):
    r = _rename(client, "Machine Learning", "ML Stuff")
    assert r.status_code == 200
    assert r.json() == {"result": "renamed", "title": "ML Stuff"}

    assert client.get("/api/page/Machine Learning").status_code == 404
    body = client.get("/api/page/ML Stuff").json()
    assert [b["text"] for b in body["blocks"]] == ["Tags:: #AI", "Papers"]

    # the daily page's [[link]] text followed the rename
    daily = client.get("/api/page/July 7th, 2026").json()
    assert "Studying [[ML Stuff]] today" in [b["text"] for b in daily["blocks"]]


def test_rename_keeps_backlinks(client, seeded_config):
    _rename(client, "Machine Learning", "ML Stuff")
    con = sqlite3.connect(seeded_config.db_path)
    refs = con.execute(
        "SELECT src_block_uid, kind FROM refs WHERE target_page_id = 1"
    ).fetchall()
    con.close()
    assert ("uid_b4", "link") in refs
    body = client.get("/api/page/ML Stuff").json()
    assert body["backlinks"]["total_pages"] == 1


def test_rename_does_not_recreate_old_page(client):
    _rename(client, "Machine Learning", "ML Stuff")
    # rewriting must not leave any block text resolving to the old title
    assert client.get("/api/page/Machine Learning").status_code == 404


def test_rename_updates_search_index(client):
    _rename(client, "Machine Learning", "Deep Learning Notes")
    pages = client.get("/api/search?q=Deep Learning Notes").json()["pages"]
    assert any(p["title"] == "Deep Learning Notes" for p in pages)


def test_rename_retitles_sidebar_entry(client):
    add = client.post("/api/sidebar", json={"title": "Machine Learning"})
    entry_id = add.json()["id"]
    _rename(client, "Machine Learning", "ML Stuff")
    entries = client.get("/api/sidebar").json()["entries"]
    assert any(e["id"] == entry_id and e["title"] == "ML Stuff"
               for e in entries)


def test_rename_case_fix_is_plain_rename(client):
    r = _rename(client, "AI", "ai")
    assert r.status_code == 200
    assert r.json()["result"] == "renamed"
    assert client.get("/api/page/ai").status_code == 200


def test_rename_missing_page_404(client):
    assert _rename(client, "No Such Page", "X").status_code == 404


def test_rename_unchanged_title_400(client):
    assert _rename(client, "AI", "AI").status_code == 400


def test_rename_blank_title_422(client):
    assert _rename(client, "AI", "   ").status_code == 422


def test_rename_daily_note_source_400(client):
    r = _rename(client, "July 7th, 2026", "Old Diary")
    assert r.status_code == 400
    assert "daily" in r.json()["detail"]


def test_rename_to_date_shaped_title_allowed(client):
    r = _rename(client, "AI", "March 3rd, 2031")
    assert r.status_code == 200
    assert client.get("/api/page/March 3rd, 2031").status_code == 200


def test_rename_requires_auth(anon_client):
    r = anon_client.post("/api/page/AI/rename",
                         json={"new_title": "X", "allow_merge": False})
    assert r.status_code == 401
