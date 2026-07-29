"""DELETE /api/assets/{sha256}: strips links, deletes emptied leaf
blocks, removes row + file (pkm-jdu3)."""
from pkm.server.db import open_db


def _upload(client, content=b"PNGDATA", name="pic.png"):
    r = client.post("/api/assets",
                    files={"file": (name, content, "image/png")})
    assert r.status_code == 200
    return r.json()


def _create_block(client, uid, page_title, text, parent_uid=None,
                  order_idx=0):
    r = client.post("/api/ops", json={
        "client_id": "test", "batch_id": f"batch-{uid}",
        "ops": [{"op": "create", "uid": uid, "page_title": page_title,
                 "parent_uid": parent_uid, "order_idx": order_idx,
                 "text": text}]})
    assert r.status_code == 200, r.text


def _block_text(config, uid):
    db = open_db(config.db_path)
    row = db.execute("SELECT text FROM blocks WHERE uid = ?",
                     (uid,)).fetchone()
    db.close()
    return None if row is None else row["text"]


def _asset_path(config, sha):
    return config.assets_dir / sha[:2] / sha


def test_delete_orphan_removes_row_and_file(client, seeded_config):
    a = _upload(client)
    path = _asset_path(seeded_config, a["sha256"])
    assert path.is_file()
    r = client.delete(f"/api/assets/{a['sha256']}")
    assert r.status_code == 200
    assert r.json() == {"deleted": True, "refs_removed": 0}
    assert not path.exists()
    hits = client.get("/api/assets/search").json()["assets"]
    assert a["sha256"] not in [h["sha256"] for h in hits]
    assert client.get(a["url"]).status_code == 404


def test_delete_unknown_sha_404(client):
    assert client.delete(f"/api/assets/{'0' * 64}").status_code == 404


def test_delete_malformed_sha_404(client):
    assert client.delete("/api/assets/not-a-sha").status_code == 404


def test_delete_strips_token_keeps_block_with_text(client, seeded_config):
    a = _upload(client)
    _create_block(client, "del001", "AI", f"diagram: ![x]({a['url']})")
    r = client.delete(f"/api/assets/{a['sha256']}")
    assert r.json() == {"deleted": True, "refs_removed": 1}
    assert _block_text(seeded_config, "del001") == "diagram:"


def test_delete_removes_emptied_leaf_block(client, seeded_config):
    a = _upload(client)
    _create_block(client, "del002", "AI", f"![]({a['url']})")
    client.delete(f"/api/assets/{a['sha256']}")
    assert _block_text(seeded_config, "del002") is None


def test_emptied_block_with_children_is_kept(client, seeded_config):
    a = _upload(client)
    _create_block(client, "del003", "AI", f"![]({a['url']})")
    _create_block(client, "del003kid", "AI", "child text",
                  parent_uid="del003", order_idx=0)
    client.delete(f"/api/assets/{a['sha256']}")
    assert _block_text(seeded_config, "del003") == ""
    assert _block_text(seeded_config, "del003kid") == "child text"


def test_deleted_block_drops_out_of_fts_refs(client):
    """Pins the FTS delete trigger user-visibly (pkm-t5pu carry-over):
    after the referencing block is deleted, a SECOND asset embedded in
    the same block no longer reports it."""
    a = _upload(client, b"AAA", "a.png")
    b = _upload(client, b"BBB", "b.png")
    _create_block(client, "del004", "AI", f"![]({a['url']}) ![]({b['url']})")
    # deleting asset A strips its token; block still holds B's token
    client.delete(f"/api/assets/{a['sha256']}")
    hit = next(h for h in client.get("/api/assets/search").json()["assets"]
               if h["sha256"] == b["sha256"])
    assert hit["refs"] == [{"uid": "del004", "page_title": "AI"}]
    # now delete B: block becomes empty -> deleted -> FTS row gone
    client.delete(f"/api/assets/{b['sha256']}")
    c = _upload(client, b"BBB", "b.png")  # same bytes, same sha as B
    hit = next(h for h in client.get("/api/assets/search").json()["assets"]
               if h["sha256"] == c["sha256"])
    assert hit["refs"] == []


def test_delete_with_missing_disk_file_still_removes_row(client,
                                                         seeded_config):
    a = _upload(client)
    _asset_path(seeded_config, a["sha256"]).unlink()
    r = client.delete(f"/api/assets/{a['sha256']}")
    assert r.status_code == 200
    hits = client.get("/api/assets/search").json()["assets"]
    assert a["sha256"] not in [h["sha256"] for h in hits]


def test_delete_strips_pdf_macro_and_bare_url(client, seeded_config):
    a = _upload(client)
    _create_block(client, "del005", "AI",
                  f"{{{{[[pdf]]: {a['url']}}}}} see also {a['url']}")
    r = client.delete(f"/api/assets/{a['sha256']}")
    assert r.json()["refs_removed"] == 1
    assert _block_text(seeded_config, "del005") == "see also"
