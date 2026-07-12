from datetime import date

from pkm.server.daily import title_for_date


def test_page_tree_shape(client):
    r = client.get("/api/page/Machine Learning")
    assert r.status_code == 200
    body = r.json()
    assert body["page"]["title"] == "Machine Learning"
    assert body["page"]["created_at"] == 1000
    texts = [b["text"] for b in body["blocks"]]
    assert texts == ["Tags:: #AI", "Papers"]
    papers = body["blocks"][1]
    assert papers["heading"] == 2
    assert [c["text"] for c in papers["children"]] == \
        ["[[Attention Is All You Need]] is a [[Paper]]"]


def test_block_ref_resolution(client):
    r = client.get("/api/page/July 7th, 2026")
    assert r.status_code == 200
    body = r.json()
    assert body["block_ref_texts"] == {
        "uid_b3": {"text": "[[Attention Is All You Need]] is a [[Paper]]",
                   "page_title": "Machine Learning"},
    }


def test_block_ref_resolution_is_transitive(client, seeded_config):
    # uid_n1's text is itself just a ((ref)) to uid_n2: the client renders
    # uid_n1's text and needs uid_n2 in the map too (nested expansion).
    import sqlite3
    con = sqlite3.connect(seeded_config.db_path)
    con.executemany("INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?)", [
        ("uid_n0", 2, None, 1, "c.f. ((uid_n1))", None, 0, None, None),
        ("uid_n1", 1, None, 2, "((uid_n2))", None, 0, None, None),
        ("uid_n2", 4, None, 0, "the actual content", None, 0, None, None),
    ])
    con.commit()
    con.close()

    body = client.get("/api/page/AI").json()
    assert body["block_ref_texts"] == {
        "uid_n1": {"text": "((uid_n2))", "page_title": "Machine Learning"},
        "uid_n2": {"text": "the actual content", "page_title": "Paper"},
    }


def test_block_ref_resolution_survives_cycles(client, seeded_config):
    # Mutually-referencing blocks must not hang resolution.
    import sqlite3
    con = sqlite3.connect(seeded_config.db_path)
    con.executemany("INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?)", [
        ("uid_c0", 2, None, 1, "start ((uid_c1))", None, 0, None, None),
        ("uid_c1", 4, None, 0, "a ((uid_c2))", None, 0, None, None),
        ("uid_c2", 4, None, 1, "b ((uid_c1)) and ((uid_gone))", None, 0, None, None),
    ])
    con.commit()
    con.close()

    body = client.get("/api/page/AI").json()
    assert body["block_ref_texts"] == {
        "uid_c1": {"text": "a ((uid_c2))", "page_title": "Paper"},
        "uid_c2": {"text": "b ((uid_c1)) and ((uid_gone))",
                   "page_title": "Paper"},
    }


def test_missing_page_404(client):
    assert client.get("/api/page/No Such Page").status_code == 404


def test_missing_daily_page_auto_creates(client):
    title = title_for_date(date(2031, 3, 3))
    r = client.get(f"/api/page/{title}")
    assert r.status_code == 200
    assert r.json()["page"]["title"] == title
    assert r.json()["blocks"] == []
    # created persistently, not per-request
    assert client.get(f"/api/page/{title}").status_code == 200


def test_namespace_title_with_slash(client, seeded_config):
    import sqlite3
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO pages(id,title) VALUES (99,'AWS/SCP')")
    con.commit()
    con.close()
    assert client.get("/api/page/AWS/SCP").status_code == 200


def test_create_page_creates_new_page(client):
    r = client.post("/api/pages", json={"title": "New Page"})
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "New Page"
    assert isinstance(body["id"], int)
    # persisted, not just returned for this request
    assert client.get("/api/page/New Page").status_code == 200


def test_create_page_is_idempotent(client):
    r = client.post("/api/pages", json={"title": "Machine Learning"})
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == 1  # existing seeded page, not a duplicate
    assert body["title"] == "Machine Learning"
    assert body["created_at"] == 1000


def test_create_page_rejects_blank_title(client):
    assert client.post("/api/pages", json={"title": ""}).status_code == 422


def test_create_page_rejects_whitespace_only_title(client):
    assert client.post("/api/pages", json={"title": "   "}).status_code == 422


def test_create_page_requires_auth(anon_client):
    r = anon_client.post("/api/pages", json={"title": "New Page"})
    assert r.status_code == 401


def test_delete_page_removes_page_and_blocks(client):
    assert client.get("/api/page/Machine Learning").status_code == 200
    r = client.delete("/api/page/Machine Learning")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert client.get("/api/page/Machine Learning").status_code == 404


def test_delete_page_removes_page_and_blocks_from_search(client):
    # Pre-delete: FTS finds the page title and its block text.
    before = client.get("/api/search?q=Papers").json()
    assert any(b["uid"] == "uid_b2" for b in before["blocks"])

    client.delete("/api/page/Machine Learning")

    after_pages = client.get("/api/search?q=Machine").json()
    assert not any(p["title"] == "Machine Learning" for p in after_pages["pages"])
    after_blocks = client.get("/api/search?q=Papers").json()
    assert not any(b["uid"] == "uid_b2" for b in after_blocks["blocks"])
    # Plain-text mention of "Machine Learning" on an unrelated page (uid_b6,
    # page "AI") is untouched -- only the deleted page's own rows are gone.
    still_there = client.get("/api/search?q=overview").json()
    assert any(b["uid"] == "uid_b6" for b in still_there["blocks"])


def test_delete_page_removes_inbound_refs_but_leaves_source_block_text(
        client, seeded_config):
    import sqlite3

    # uid_b4 (page "July 7th, 2026") links to "Machine Learning" (page id 1).
    r = client.get("/api/page/July 7th, 2026")
    texts_before = [b["text"] for b in r.json()["blocks"]]
    assert "Studying [[Machine Learning]] today" in texts_before

    client.delete("/api/page/Machine Learning")

    r = client.get("/api/page/July 7th, 2026")
    texts_after = [b["text"] for b in r.json()["blocks"]]
    # The block text (and thus the literal [[link]]) is untouched.
    assert texts_after == texts_before

    # But the refs row pointing at the now-deleted page is gone.
    con = sqlite3.connect(seeded_config.db_path)
    remaining = con.execute(
        "SELECT * FROM refs WHERE target_page_id = 1").fetchall()
    con.close()
    assert remaining == []


def test_delete_page_removes_sidebar_entry(client):
    add = client.post("/api/sidebar", json={"title": "Machine Learning"})
    assert add.status_code == 200
    entry_id = add.json()["id"]

    client.delete("/api/page/Machine Learning")

    entries = client.get("/api/sidebar").json()["entries"]
    assert not any(e["id"] == entry_id for e in entries)


def test_delete_missing_page_404(client):
    assert client.delete("/api/page/No Such Page").status_code == 404


def test_delete_page_requires_auth(anon_client):
    r = anon_client.delete("/api/page/Machine Learning")
    assert r.status_code == 401
