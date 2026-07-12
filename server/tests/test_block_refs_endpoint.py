"""GET /api/block-refs: on-demand ((uid)) resolution for freshly pasted refs
(pkm-y6af). Same transitive semantics as the page payload's block_ref_texts."""


def test_resolves_requested_uids(client):
    r = client.get("/api/block-refs?uids=uid_b3")
    assert r.status_code == 200
    assert r.json()["block_ref_texts"] == {
        "uid_b3": {"text": "[[Attention Is All You Need]] is a [[Paper]]",
                   "page_title": "Machine Learning"},
    }


def test_resolves_transitively(client):
    # uid_b5's text contains ((uid_b3)): the client renders uid_b5's text
    # nested, so uid_b3 must land in the map too.
    r = client.get("/api/block-refs?uids=uid_b5")
    assert r.status_code == 200
    body = r.json()["block_ref_texts"]
    assert set(body) == {"uid_b5", "uid_b3"}
    assert body["uid_b5"]["text"] == "See ((uid_b3)) for details"


def test_unknown_uids_are_omitted(client):
    r = client.get("/api/block-refs?uids=uid_gone,uid_b3")
    assert r.status_code == 200
    assert set(r.json()["block_ref_texts"]) == {"uid_b3"}


def test_empty_uids_returns_empty_map(client):
    r = client.get("/api/block-refs?uids=")
    assert r.status_code == 200
    assert r.json()["block_ref_texts"] == {}


def test_malformed_uid_rejected(client):
    # too short and bad characters both fail the ^[a-zA-Z0-9_-]{6,32}$ shape
    assert client.get("/api/block-refs?uids=abc").status_code == 422
    assert client.get("/api/block-refs?uids=uid_b3,has%20space").status_code == 422


def test_too_many_uids_rejected(client):
    uids = ",".join(f"uid_x{i:04d}" for i in range(51))
    assert client.get(f"/api/block-refs?uids={uids}").status_code == 422


def test_requires_auth(anon_client):
    assert anon_client.get("/api/block-refs?uids=uid_b3").status_code == 401
