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
    con.commit(); con.close()
    assert client.get("/api/page/AWS/SCP").status_code == 200
