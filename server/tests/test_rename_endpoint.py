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


def test_rename_collision_409_changes_nothing(client):
    r = _rename(client, "AI", "Machine Learning")
    assert r.status_code == 409
    # both pages intact, text untouched
    assert client.get("/api/page/AI").status_code == 200
    ml = client.get("/api/page/Machine Learning").json()
    assert [b["text"] for b in ml["blocks"]] == ["Tags:: #AI", "Papers"]


def test_merge_appends_blocks_and_rewrites_refs(client):
    r = _rename(client, "AI", "Machine Learning", allow_merge=True)
    assert r.status_code == 200
    assert r.json() == {"result": "merged", "title": "Machine Learning"}

    assert client.get("/api/page/AI").status_code == 404
    ml = client.get("/api/page/Machine Learning").json()
    texts = [b["text"] for b in ml["blocks"]]
    # target blocks first, source's top-level block appended; uid_b1's
    # "#AI" tag rewrote to the bracketed form (new title has a space)
    assert texts == ["Tags:: #[[Machine Learning]]", "Papers",
                     "AI overview mentions Machine Learning in plain text"]


def test_merge_repoints_refs_to_target(client, seeded_config):
    _rename(client, "AI", "Machine Learning", allow_merge=True)
    con = sqlite3.connect(seeded_config.db_path)
    assert con.execute(
        "SELECT count(*) FROM refs WHERE target_page_id = 2").fetchone()[0] == 0
    assert ("uid_b1",) in con.execute(
        "SELECT src_block_uid FROM refs WHERE target_page_id = 1").fetchall()
    con.close()


def test_merge_preserves_source_subtrees(client, seeded_config):
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " collapsed) VALUES ('uid_child', 2, 'uid_b6', 0, 'nested', 0)")
    con.commit()
    con.close()
    _rename(client, "AI", "Machine Learning", allow_merge=True)
    ml = client.get("/api/page/Machine Learning").json()
    appended = ml["blocks"][2]
    assert appended["text"].startswith("AI overview")
    assert [c["text"] for c in appended["children"]] == ["nested"]


def test_merge_case_variants(client):
    client.post("/api/pages", json={"title": "cLaude"})
    client.post("/api/pages", json={"title": "Claude"})
    r = _rename(client, "cLaude", "Claude")
    assert r.status_code == 409
    r = _rename(client, "cLaude", "Claude", allow_merge=True)
    assert r.status_code == 200 and r.json()["result"] == "merged"
    assert client.get("/api/page/cLaude").status_code == 404


def test_merge_block_with_both_titles_dedupes_refs(client, seeded_config):
    con = sqlite3.connect(seeded_config.db_path)
    con.executescript("""
        INSERT INTO pages(id, title) VALUES (60, 'cLaude'), (61, 'Claude');
        INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,
                           collapsed)
        VALUES ('uid_both', 4, NULL, 1, '[[cLaude]] vs [[Claude]]', 0);
        INSERT INTO refs VALUES ('uid_both', 60, 'link'),
                                ('uid_both', 61, 'link');
    """)
    con.commit()
    con.close()
    _rename(client, "cLaude", "Claude", allow_merge=True)
    con = sqlite3.connect(seeded_config.db_path)
    text = con.execute("SELECT text FROM blocks WHERE uid = 'uid_both'"
                       ).fetchone()[0]
    refs = con.execute("SELECT target_page_id, kind FROM refs"
                       " WHERE src_block_uid = 'uid_both'").fetchall()
    con.close()
    assert text == "[[Claude]] vs [[Claude]]"
    assert refs == [(61, "link")]


def test_merge_sidebar_both_pinned_keeps_target_entry(client):
    client.post("/api/sidebar", json={"title": "AI"})
    add = client.post("/api/sidebar", json={"title": "Machine Learning"})
    target_entry = add.json()["id"]
    _rename(client, "AI", "Machine Learning", allow_merge=True)
    entries = client.get("/api/sidebar").json()["entries"]
    titles = [e["title"] for e in entries]
    assert titles.count("Machine Learning") == 1
    assert any(e["id"] == target_entry for e in entries)


def test_allow_merge_without_collision_is_plain_rename(client):
    r = _rename(client, "AI", "Fresh Title", allow_merge=True)
    assert r.status_code == 200
    assert r.json()["result"] == "renamed"
