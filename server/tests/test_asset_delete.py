"""DELETE /api/assets/{sha256}: strips links, deletes emptied leaf
blocks, removes row + file."""
import pytest
from conftest import asgi_request
from export_hostile import ASSET_NAMES, add_asset_rows
from rawread import read, table_rows
from pkm.server.db import open_db
from pkm.contracts.ops import BlockUid, OrderIdx, Sha256Hex
from pkm.test_data.ids import order_idx_of, raw_title_of, uid_of


def _upload(client, content=b"PNGDATA", name="pic.png"):
    r = client.post("/api/assets",
                    files={"file": (name, content, "image/png")})
    assert r.status_code == 200
    return r.json()


def _create_block(client, uid: BlockUid, page, text,
                  parent_uid: BlockUid | None = None,
                  order_idx: OrderIdx = order_idx_of(0)):
    r = client.post("/api/ops", json={
        "client_id": "test", "batch_id": f"batch-{uid}",
        "ops": [{"op": "create", "uid": uid, "page_title": raw_title_of(page),
                 "parent_uid": parent_uid, "order_idx": order_idx,
                 "text": text}]})
    assert r.status_code == 200, r.text


def _block_text(config, uid: BlockUid):
    db = open_db(config.db_path)
    row = db.select_one("SELECT text FROM blocks WHERE uid = ?", (uid,))
    db.close()
    return None if row is None else row["text"]


def _asset_path(config, sha: Sha256Hex):
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
    _create_block(client, uid_of("del001"), "AI", f"diagram: ![x]({a['url']})")
    r = client.delete(f"/api/assets/{a['sha256']}")
    assert r.json() == {"deleted": True, "refs_removed": 1}
    assert _block_text(seeded_config, uid_of("del001")) == "diagram:"


def test_delete_removes_emptied_leaf_block(client, seeded_config):
    a = _upload(client)
    _create_block(client, uid_of("del002"), "AI", f"![]({a['url']})")
    client.delete(f"/api/assets/{a['sha256']}")
    assert _block_text(seeded_config, uid_of("del002")) is None


def test_emptied_block_with_children_is_kept(client, seeded_config):
    a = _upload(client)
    _create_block(client, uid_of("del003"), "AI", f"![]({a['url']})")
    _create_block(client, uid_of("del003kid"), "AI", "child text",
                  parent_uid=uid_of("del003"), order_idx=order_idx_of(0))
    client.delete(f"/api/assets/{a['sha256']}")
    assert _block_text(seeded_config, uid_of("del003")) == ""
    assert _block_text(seeded_config, uid_of("del003kid")) == "child text"


def test_deleted_block_drops_out_of_fts_refs(client):
    """Pins the FTS delete trigger user-visibly: after the referencing
    block is deleted, a SECOND asset embedded in the same block no longer
    reports it."""
    a = _upload(client, b"AAA", "a.png")
    b = _upload(client, b"BBB", "b.png")
    _create_block(client, uid_of("del004"), "AI", f"![]({a['url']}) ![]({b['url']})")
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
    _create_block(client, uid_of("del005"), "AI",
                  f"{{{{[[pdf]]: {a['url']}}}}} see also {a['url']}")
    r = client.delete(f"/api/assets/{a['sha256']}")
    assert r.json()["refs_removed"] == 1
    assert _block_text(seeded_config, uid_of("del005")) == "see also"


def test_delete_strips_link_with_spaces_and_parens_in_filename(
        client, seeded_config):
    # _upload always names the file "pic.png" -- the server only matches
    # on sha256, so build the link text from the real sha but a made-up
    # raw filename, the way an upload of a real-world PDF would.
    a = _upload(client)
    name = "AI for Research Day 2026 - Programme (Public) - Schedule.pdf"
    url = f"/assets/{a['sha256']}/{name}"
    _create_block(client, uid_of("del006"), "AI", f"before [{name}]({url}) after")
    r = client.delete(f"/api/assets/{a['sha256']}")
    assert r.json()["refs_removed"] == 1
    assert _block_text(seeded_config, uid_of("del006")) == "before after"


def test_if_unreferenced_deletes_an_orphan(client, seeded_config):
    a = _upload(client)
    path = _asset_path(seeded_config, a["sha256"])
    r = client.delete(f"/api/assets/{a['sha256']}?if_unreferenced=true")
    assert r.status_code == 200
    assert r.json() == {"deleted": True, "refs_removed": 0}
    assert not path.exists()
    db = open_db(seeded_config.db_path)
    row = read(db, "SELECT 1 FROM assets WHERE sha256 = ?",
                     (a["sha256"],)).fetchone()
    db.close()
    assert row is None


def test_if_unreferenced_refuses_a_referenced_asset(client, seeded_config):
    a = _upload(client)
    text = f"![pic.png]({a['url']})"
    _create_block(client, uid_of("cond001"), "AI", text)
    r = client.delete(f"/api/assets/{a['sha256']}?if_unreferenced=true")
    assert r.status_code == 409
    assert r.json()["detail"] == "asset is referenced"
    assert _block_text(seeded_config, uid_of("cond001")) == text
    assert _asset_path(seeded_config, a["sha256"]).is_file()
    db = open_db(seeded_config.db_path)
    row = read(db, "SELECT 1 FROM assets WHERE sha256 = ?",
                     (a["sha256"],)).fetchone()
    db.close()
    assert row is not None


def test_if_unreferenced_unknown_is_404(client):
    q = "?if_unreferenced=true"
    assert client.delete(f"/api/assets/{'a' * 64}{q}").status_code == 404
    assert client.delete(f"/api/assets/not-a-sha{q}").status_code == 404


def test_without_flag_still_strips(client, seeded_config):
    a = _upload(client)
    _create_block(client, uid_of("cond002"), "AI", f"x ![p]({a['url']})")
    r = client.delete(f"/api/assets/{a['sha256']}")
    assert r.json()["refs_removed"] == 1


def test_if_unreferenced_answers_503_while_the_write_lock_is_held(
        client, seeded_config, monkeypatch):
    # The reference check runs under BEGIN IMMEDIATE: a held write lock
    # means no check, no delete.
    a = _upload(client)
    monkeypatch.setattr("pkm.server.db.BUSY_TIMEOUT_MS", 50)
    holder = open_db(seeded_config.db_path)
    holder.execute("BEGIN IMMEDIATE")
    try:
        r = client.delete(f"/api/assets/{a['sha256']}?if_unreferenced=true")
    finally:
        holder.rollback()
        holder.close()
    assert r.status_code == 503
    assert r.headers["Retry-After"] == "1"
    assert _asset_path(seeded_config, a["sha256"]).is_file()
    db = open_db(seeded_config.db_path)
    row = read(db, "SELECT 1 FROM assets WHERE sha256 = ?",
                     (a["sha256"],)).fetchone()
    db.close()
    assert row is not None


def test_strip_holds_the_write_lock_from_its_first_read_on(
        client, seeded_config, monkeypatch):
    # A batch editing a referencing block between the strip's read of its
    # text and the UPDATE would be overwritten with no conflict note. The
    # route must hold the write lock across the read.
    import sqlite3
    from pkm.database import connect
    from pkm.server import routes_assets

    a = _upload(client)
    _create_block(client, uid_of("del010"), "AI", f"keep ![x]({a['url']})")
    real_strip = routes_assets.strip_asset_tokens
    outcome = {}

    def racing(text: str, sha: Sha256Hex) -> str:
        con2 = connect(seeded_config.db_path)
        con2.execute("PRAGMA busy_timeout=50")
        try:
            con2.execute("UPDATE blocks SET text = 'late edit'"
                         " WHERE uid = 'del010'")
            con2.commit()
            outcome["locked"] = False
        except sqlite3.OperationalError as exc:
            outcome["locked"] = "locked" in str(exc)
        finally:
            con2.close()
        return real_strip(text, sha)

    monkeypatch.setattr(routes_assets, "strip_asset_tokens", racing)
    assert client.delete(f"/api/assets/{a['sha256']}").status_code == 200
    assert outcome == {"locked": True}


def test_strip_answers_503_while_the_write_lock_is_held(
        client, seeded_config, monkeypatch):
    a = _upload(client)
    _create_block(client, uid_of("del011"), "AI", f"keep ![x]({a['url']})")
    monkeypatch.setattr("pkm.server.db.BUSY_TIMEOUT_MS", 50)
    holder = open_db(seeded_config.db_path)
    holder.execute("BEGIN IMMEDIATE")
    try:
        r = client.delete(f"/api/assets/{a['sha256']}")
    finally:
        holder.rollback()
        holder.close()
    assert r.status_code == 503
    assert r.headers["Retry-After"] == "1"
    assert _asset_path(seeded_config, a["sha256"]).is_file()
    assert _block_text(seeded_config, uid_of("del011")) == (
        f"keep ![x]({a['url']})")


_HOSTILE_DIGESTS = pytest.mark.parametrize("shape", [
    lambda sha: "..%2F..%2Fpkm.sqlite3", lambda sha: "%2e%2e",
    lambda sha: sha + "%0a", lambda sha: sha.upper(), lambda sha: sha[:63]],
    ids=["dotdot-escaped-slash", "dotdot-escaped", "trailing-newline",
         "upper", "short"])


@_HOSTILE_DIGESTS
def test_delete_with_a_hostile_digest_is_404_and_changes_nothing(
        client, seeded_config, shape):
    """The digest in the path becomes a file path: anything but 64
    lowercase hex must be refused before any file or row is touched, even
    a spelling of a digest that is stored. The exact raw path is sent,
    since TestClient decodes escapes twice."""
    shas = add_asset_rows(seeded_config.db_path, seeded_config.assets_dir,
                          ASSET_NAMES)
    rows_before = _asset_rows(seeded_config)

    r = asgi_request(client.app, "DELETE", "/api/assets/" + shape(shas[0]),
                     cookie=client.cookies["pkm_session"])

    assert r.status_code == 404
    assert seeded_config.db_path.is_file()
    assert _asset_rows(seeded_config) == rows_before
    for sha in shas:
        assert (seeded_config.assets_dir / sha[:2] / sha).is_file()


def _asset_rows(config):
    db = open_db(config.db_path)
    try:
        return table_rows(db, "assets")
    finally:
        db.close()


@_HOSTILE_DIGESTS
def test_serving_a_hostile_digest_is_404(client, seeded_config, shape):
    """The serve route's digest also becomes a file path, so the same five
    spellings must answer 404, even those that spell a stored digest."""
    shas = add_asset_rows(seeded_config.db_path, seeded_config.assets_dir,
                          ASSET_NAMES)

    r = asgi_request(client.app, "GET", f"/assets/{shape(shas[0])}/x.png",
                     cookie=client.cookies["pkm_session"])

    assert r.status_code == 404
