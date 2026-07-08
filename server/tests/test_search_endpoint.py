def test_search_finds_pages_and_blocks(client):
    r = client.get("/api/search", params={"q": "machine"})
    assert r.status_code == 200
    body = r.json()
    assert [p["title"] for p in body["pages"]] == ["Machine Learning"]
    uids = {b["uid"] for b in body["blocks"]}
    assert uids == {"uid_b4", "uid_b6"}
    hit = next(b for b in body["blocks"] if b["uid"] == "uid_b6")
    assert "<mark>Machine</mark>" in hit["snippet"]
    assert hit["page_title"] == "AI"


def test_search_prefix_match(client):
    body = client.get("/api/search", params={"q": "attent"}).json()
    assert [p["title"] for p in body["pages"]] == ["Attention Is All You Need"]
    assert {b["uid"] for b in body["blocks"]} == {"uid_b3"}


def test_search_empty_query(client):
    body = client.get("/api/search", params={"q": "  "}).json()
    assert body == {"pages": [], "blocks": []}


def test_search_quote_injection_is_safe(client):
    r = client.get("/api/search", params={"q": 'NEAR( "x" OR'})
    assert r.status_code == 200  # escaped, not parsed as FTS syntax
