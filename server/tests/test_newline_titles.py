"""Page titles must never contain a control whitespace char.

Nothing ever calls a create endpoint for these -- a multi-line [[link]] in
block text is enough, since ref indexing calls get_or_create_page() for
every extracted ref. So the title is normalized where it is born
(refs.extract) and again at the single creation choke point
(store.get_or_create_page). A spelling with a newline that arrives as a
lookup key is folded onto the same title, URL path included: the page
routes take `{title:wholepath}`, whose pattern matches a newline.
"""
from urllib.parse import quote

from pkm.database import connect

MULTILINE = "Paper/Levels of AGI:\nthe Path to AGI"
NORMALIZED = "Paper/Levels of AGI: the Path to AGI"

_batch_counter = 0


def _post_ops(client, *ops):
    global _batch_counter
    _batch_counter += 1
    return client.post("/api/ops",
                       json={"client_id": "c1",
                             "batch_id": f"nl_batch_{_batch_counter:08d}",
                             "ops": list(ops)})


def _titles(config) -> list[str]:
    con = connect(config.db_path)
    try:
        return [r["title"] for r in con.select("SELECT title FROM pages")]
    finally:
        con.close()


def _control_char_titles(config) -> list[str]:
    return [t for t in _titles(config)
            if any(ord(c) < 0x20 for c in t)]


def test_multiline_link_in_block_text_creates_a_reachable_page(client,
                                                               seeded_config):
    """The exact prod scenario: a two-line [[link]] pasted into a block."""
    r = _post_ops(client, {"op": "create", "uid": "nlblock1",
                           "page_title": "Machine Learning",
                           "parent_uid": None, "order_idx": 5,
                           "text": f"see [[{MULTILINE}]] now"})
    assert r.status_code == 200

    # the implicitly created page is single-line, and therefore addressable
    assert NORMALIZED in _titles(seeded_config)
    assert client.get(f"/api/page/{NORMALIZED}").status_code == 200
    assert _control_char_titles(seeded_config) == []


def test_multiline_link_backlink_points_at_the_normalized_page(client):
    """The block text keeps its newline -- only the ref target is
    normalized, so the backlink still reads exactly as it was typed."""
    _post_ops(client, {"op": "create", "uid": "nlblock2",
                       "page_title": "Machine Learning", "parent_uid": None,
                       "order_idx": 5, "text": f"see [[{MULTILINE}]] now"})
    groups = client.get(f"/api/page/{NORMALIZED}").json()["backlinks"]["groups"]
    assert [i["text"] for g in groups for i in g["items"]] == \
        [f"see [[{MULTILINE}]] now"]


def test_create_op_with_a_multiline_page_title_is_normalized(client,
                                                            seeded_config):
    r = _post_ops(client, {"op": "create", "uid": "nlblock3",
                           "page_title": MULTILINE, "parent_uid": None,
                           "order_idx": 0, "text": "body text"})
    assert r.status_code == 200
    body = client.get(f"/api/page/{NORMALIZED}").json()
    assert [b["text"] for b in body["blocks"]] == ["body text"]
    assert _control_char_titles(seeded_config) == []


def test_create_op_broadcast_uses_the_normalized_page_title(client):
    with client.websocket_connect("/api/ws") as ws:
        r = _post_ops(client, {"op": "create", "uid": "nlbroadcast1",
                               "page_title": MULTILINE, "parent_uid": None,
                               "order_idx": 0, "text": "body text"})
        assert r.status_code == 200
        assert ws.receive_json()["ops"] == [{
            "op": "create",
            "uid": "nlbroadcast1",
            "page_title": NORMALIZED,
            "parent_uid": None,
            "order_idx": 0,
            "text": "body text",
            "heading": None,
            "view_type": None,
        }]


def test_create_page_broadcast_uses_the_normalized_page_title(client):
    with client.websocket_connect("/api/ws") as ws:
        r = _post_ops(client, {"op": "create_page", "page_title": MULTILINE})
        assert r.status_code == 200
        assert ws.receive_json()["ops"] == [{
            "op": "create_page",
            "page_title": NORMALIZED,
        }]


def test_move_op_broadcast_uses_the_normalized_page_title(client):
    with client.websocket_connect("/api/ws") as ws:
        r = _post_ops(client, {"op": "move", "uid": "uid_b1",
                               "parent_uid": None, "order_idx": 0,
                               "page_title": MULTILINE})
        assert r.status_code == 200
        assert ws.receive_json()["ops"] == [{
            "op": "move",
            "uid": "uid_b1",
            "parent_uid": None,
            "order_idx": 0,
            "page_title": NORMALIZED,
        }]


def test_create_page_endpoint_normalizes(client, seeded_config):
    r = client.post("/api/pages", json={"title": MULTILINE})
    assert r.status_code == 200
    assert r.json()["title"] == NORMALIZED
    assert _control_char_titles(seeded_config) == []


def test_create_page_endpoint_is_idempotent_across_spellings(client):
    first = client.post("/api/pages", json={"title": NORMALIZED}).json()
    second = client.post("/api/pages", json={"title": MULTILINE}).json()
    assert first["id"] == second["id"]


def test_rename_to_a_multiline_title_is_normalized(client, seeded_config):
    r = client.post("/api/page/Machine Learning/rename",
                    json={"new_title": MULTILINE, "allow_merge": False})
    assert r.status_code == 200
    assert r.json() == {"result": "renamed", "title": NORMALIZED}
    assert client.get(f"/api/page/{NORMALIZED}").status_code == 200
    assert _control_char_titles(seeded_config) == []


def test_move_op_page_title_is_normalized(client, seeded_config):
    r = _post_ops(client, {"op": "move", "uid": "uid_b1", "parent_uid": None,
                           "order_idx": 0, "page_title": MULTILINE})
    assert r.status_code == 200
    body = client.get(f"/api/page/{NORMALIZED}").json()
    assert [b["text"] for b in body["blocks"]] == ["Tags:: #AI"]
    assert _control_char_titles(seeded_config) == []


def test_a_title_with_only_plain_spaces_is_untouched(client):
    """The normalizer is narrow on purpose -- no control char, no change."""
    r = client.post("/api/pages", json={"title": "Two  Spaces"})
    assert r.status_code == 200
    assert r.json()["title"] == "Two  Spaces"
    assert client.get("/api/page/Two  Spaces").status_code == 200


def test_a_title_that_is_only_whitespace_is_still_rejected(client):
    """strip()-to-blank already 422s; a newline-only title must too, rather
    than normalizing to "" and creating a blank-titled page."""
    assert client.post("/api/pages", json={"title": "\n\t"}).status_code == 422


def test_page_routes_fold_a_newline_in_the_url_onto_the_page(client):
    # Starlette's `path` convertor matched no route for an inner newline,
    # and dropped a final one, leaving "Fo o " (a different, missing title).
    assert client.post("/api/pages", json={"title": "Fo o"}).status_code == 200
    for spelling in ("Fo\no", "Fo o \n", "\tFo o"):
        path = quote(spelling, safe="")
        page = client.get(f"/api/page/{path}")
        assert page.status_code == 200, spelling
        assert page.json()["page"]["title"] == "Fo o"
        assert client.get(f"/api/export/page/{path}").status_code == 200
    renamed = client.post(f"/api/page/{quote('Fo o ' + chr(10))}/rename",
                          json={"new_title": "Fo o 2"})
    assert renamed.json() == {"result": "renamed", "title": "Fo o 2"}
    assert client.delete(f"/api/page/{quote('Fo o 2' + chr(10))}").status_code == 200
    assert client.get("/api/page/Fo%20o%202").status_code == 404


def test_an_orphan_edits_header_links_the_page_the_hint_names(client, seeded_config):
    # The hint's own spelling made the header a multi-line link.
    r = _post_ops(client, {"op": "update_text", "uid": "gone_blk01", "text": "kept",
                           "page_title": "Machine\nLearning "})
    assert r.status_code == 200
    con = connect(seeded_config.db_path)
    try:
        texts = [r["text"] for r in con.select("SELECT text FROM blocks")]
    finally:
        con.close()
    assert ("[[conflict]] [[Machine Learning]] — edit to a block the server"
            " no longer has") in texts
