"""GET /api/block/{uid}: subtree + page context (pkm-w05j)."""


def test_block_returns_subtree_page_and_breadcrumbs(client):
    r = client.get("/api/block/uid_b3")
    assert r.status_code == 200
    body = r.json()
    assert body["page"]["title"] == "Machine Learning"
    assert body["block"]["uid"] == "uid_b3"
    assert body["block"]["text"] == "[[Attention Is All You Need]] is a [[Paper]]"
    assert body["block"]["children"] == []
    assert body["breadcrumbs"] == ["Papers"]  # ancestor texts, root first


def test_block_subtree_includes_descendants(client):
    r = client.get("/api/block/uid_b2")
    assert r.status_code == 200
    kids = r.json()["block"]["children"]
    assert [k["uid"] for k in kids] == ["uid_b3"]


def test_block_resolves_block_refs_in_subtree(client):
    r = client.get("/api/block/uid_b5")  # text: "See ((uid_b3)) for details"
    assert r.status_code == 200
    assert "uid_b3" in r.json()["block_ref_texts"]


def test_block_top_level_has_empty_breadcrumbs(client):
    r = client.get("/api/block/uid_b1")
    assert r.json()["breadcrumbs"] == []


def test_block_unknown_uid_404(client):
    assert client.get("/api/block/zzzzzz").status_code == 404


def test_block_malformed_uid_422(client):
    assert client.get("/api/block/no").status_code == 422  # shorter than UID_RE


def test_block_requires_auth(anon_client):
    assert anon_client.get("/api/block/uid_b1").status_code == 401
