"""Filters + pagination on GET /api/assets/search (pkm-jdu3)."""
from pkm.server.db import open_db


def _upload(client, content, name, mime="image/png"):
    r = client.post("/api/assets", files={"file": (name, content, mime)})
    assert r.status_code == 200
    return r.json()


def _create_block(client, uid, page_title, text):
    r = client.post("/api/ops", json={
        "client_id": "test", "batch_id": f"batch-{uid}",
        "ops": [{"op": "create", "uid": uid, "page_title": page_title,
                 "parent_uid": None, "order_idx": 0, "text": text}]})
    assert r.status_code == 200, r.text


def _set_created_at(config, sha, ms):
    db = open_db(config.db_path)
    db.execute("UPDATE assets SET created_at = ? WHERE sha256 = ?",
               (ms, sha))
    db.commit()
    db.close()


def _search(client, **params):
    r = client.get("/api/assets/search", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_type_filter(client):
    png = _upload(client, b"PNG1", "a.png")
    _upload(client, b"%PDF-1.4 x", "b.pdf", "application/pdf")
    got = _search(client, type="image")
    assert [a["sha256"] for a in got["assets"]] == [png["sha256"]]
    assert got["total"] == 1


def test_date_filter_bounds_inclusive_and_null_excluded(client,
                                                        seeded_config):
    early = _upload(client, b"E", "early.png")
    late = _upload(client, b"L", "late.png")
    undated = _upload(client, b"U", "undated.png")
    _set_created_at(seeded_config, early["sha256"], 1000)
    _set_created_at(seeded_config, late["sha256"], 2000)
    _set_created_at(seeded_config, undated["sha256"], None)
    got = _search(client, from_ms=1000, to_ms=1000)
    assert [a["sha256"] for a in got["assets"]] == [early["sha256"]]
    got = _search(client, from_ms=0)
    assert {a["sha256"] for a in got["assets"]} == {
        early["sha256"], late["sha256"]}


def test_linked_and_orphan_filters(client):
    linked = _upload(client, b"LNK", "linked.png")
    orphan = _upload(client, b"ORF", "orphan.png")
    _create_block(client, "flt001", "AI", f"pic ![]({linked['url']})")
    got = _search(client, linked="linked")
    assert [a["sha256"] for a in got["assets"]] == [linked["sha256"]]
    assert got["total"] == 1
    got = _search(client, linked="orphan")
    assert [a["sha256"] for a in got["assets"]] == [orphan["sha256"]]


def test_orphan_filter_paginates_over_filtered_set(client, seeded_config):
    shas = []
    for i in range(3):
        a = _upload(client, f"O{i}".encode(), f"o{i}.png")
        _set_created_at(seeded_config, a["sha256"], 1000 + i)
        shas.append(a["sha256"])
    linked = _upload(client, b"LNK", "linked.png")
    _set_created_at(seeded_config, linked["sha256"], 5000)
    _create_block(client, "flt002", "AI", f"![]({linked['url']})")
    got = _search(client, linked="orphan", limit=2, offset=0)
    assert got["total"] == 3
    # newest-first: o2, o1 on page one; o0 on page two
    assert [a["sha256"] for a in got["assets"]] == [shas[2], shas[1]]
    got = _search(client, linked="orphan", limit=2, offset=2)
    assert [a["sha256"] for a in got["assets"]] == [shas[0]]


def test_offset_past_end_returns_empty_with_total(client):
    _upload(client, b"X", "x.png")
    got = _search(client, offset=99)
    assert got["assets"] == [] and got["total"] == 1


def test_from_after_to_returns_empty(client, seeded_config):
    a = _upload(client, b"X", "x.png")
    _set_created_at(seeded_config, a["sha256"], 1500)
    got = _search(client, from_ms=2000, to_ms=1000)
    assert got["assets"] == [] and got["total"] == 0


def test_bad_type_and_linked_values_rejected(client):
    assert client.get("/api/assets/search",
                      params={"type": "video"}).status_code == 422
    assert client.get("/api/assets/search",
                      params={"linked": "nope"}).status_code == 422


def test_payload_carries_describe_error(client):
    a = _upload(client, b"X", "x.png")
    hit = next(h for h in _search(client)["assets"]
               if h["sha256"] == a["sha256"])
    assert hit["describe_error"] is None
    assert hit["status"] == "pending"


def test_filters_combine_with_q(client):
    a = _upload(client, b"A", "alpha-notes.png")
    _upload(client, b"B", "beta-notes.png")
    _upload(client, b"C", "alpha-notes.pdf", "application/pdf")
    got = _search(client, q="alpha", type="image")
    assert [x["sha256"] for x in got["assets"]] == [a["sha256"]]
