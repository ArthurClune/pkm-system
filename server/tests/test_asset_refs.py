"""GET /api/assets/search returns referencing blocks (pkm-t5pu)."""


def _upload(client, content=b"PNGDATA", name="pic.png"):
    r = client.post("/api/assets",
                    files={"file": (name, content, "image/png")})
    assert r.status_code == 200
    return r.json()


def _create_block(client, uid, page_title, text, order_idx=10):
    r = client.post("/api/ops", json={
        "client_id": "test", "batch_id": f"batch-{uid}",
        "ops": [{"op": "create", "uid": uid, "page_title": page_title,
                 "parent_uid": None, "order_idx": order_idx, "text": text}]})
    assert r.status_code == 200, r.text


def _search_hit(client, sha):
    hits = client.get("/api/assets/search",
                      params={"q": ""}).json()["assets"]
    return next(h for h in hits if h["sha256"] == sha)


def test_referenced_asset_carries_refs(client):
    asset = _upload(client)
    _create_block(client, "refblk1", "AI",
                  f"diagram: ![]({asset['url']})")
    hit = _search_hit(client, asset["sha256"])
    assert hit["refs"] == [{"uid": "refblk1", "page_title": "AI"}]


def test_unreferenced_asset_has_empty_refs(client):
    asset = _upload(client)
    assert _search_hit(client, asset["sha256"])["refs"] == []


def test_refs_ordered_by_page_title_then_uid(client):
    asset = _upload(client)
    url = asset["url"]
    # insertion order deliberately scrambled vs expected output order
    _create_block(client, "zz_last", "AI", f"see ![]({url})", order_idx=11)
    _create_block(client, "aa_first", "AI", f"also ![]({url})", order_idx=12)
    _create_block(client, "mlblk1", "Machine Learning", f"![]({url})")
    hit = _search_hit(client, asset["sha256"])
    assert hit["refs"] == [
        {"uid": "aa_first", "page_title": "AI"},
        {"uid": "zz_last", "page_title": "AI"},
        {"uid": "mlblk1", "page_title": "Machine Learning"},
    ]


def test_refs_uncapped_beyond_a_handful(client):
    asset = _upload(client)
    for i in range(8):
        _create_block(client, f"many{i:02d}", "AI",
                      f"copy {i}: ![]({asset['url']})", order_idx=20 + i)
    hit = _search_hit(client, asset["sha256"])
    assert len(hit["refs"]) == 8
