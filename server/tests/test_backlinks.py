"""Backlink routes. group_backlinks itself is tested in test_grouping.py,
beside the plain group_by_page it deliberately does not share."""


def test_page_endpoint_includes_backlinks(client):
    body = client.get("/api/page/Machine Learning").json()
    bl = body["backlinks"]
    assert bl["total_pages"] == 1
    [group] = bl["groups"]
    assert group["page_title"] == "July 7th, 2026"
    assert [i["text"] for i in group["items"]] == \
        ["Studying [[Machine Learning]] today"]


def test_backlink_breadcrumbs(client):
    # uid_b3 is nested under uid_b2 ("Papers") — backlinks of "Paper" show the
    # chain
    body = client.get("/api/page/Paper").json()
    [group] = body["backlinks"]["groups"]
    assert group["page_title"] == "Machine Learning"
    [item] = group["items"]
    assert item["uid"] == "uid_b3"
    assert item["ancestor_uids"] == ["uid_b2"]
    assert body["backlinks"]["ancestor_texts"] == {"uid_b2": "Papers"}


def test_backlink_pagination_params(client):
    body = client.get("/api/page/Machine Learning",
                      params={"bl_limit": 1, "bl_offset": 1}).json()
    assert body["backlinks"]["groups"] == []
    assert body["backlinks"]["total_pages"] == 1
    assert body["backlinks"]["offset"] == 1


def test_backlinks_exclude_the_pages_own_blocks(client, seeded_config):
    """A block on page P that references [[P]] (Roam-style {{[[TODO]]}}
    markers on the TODO page are the common case) is not a linked
    reference to P -- the page cannot be its own backlink source, just as
    unlinked references already skip the current page."""
    from pkm.server.db import open_db
    con = open_db(seeded_config.db_path)
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        ("uid_self", 1, None, 2, "{{[[TODO]]}} revisit [[Machine Learning]]",
         None, 0, None, None))
    con.execute("INSERT INTO refs VALUES (?,?,?)", ("uid_self", 1, "link"))
    con.commit()
    con.close()
    bl = client.get("/api/page/Machine Learning").json()["backlinks"]
    assert bl["total_pages"] == 1
    assert [g["page_title"] for g in bl["groups"]] == ["July 7th, 2026"]
    assert all(i["uid"] != "uid_self" for g in bl["groups"] for i in g["items"])


def test_deep_chain_backlinks_send_each_ancestor_once(client):
    """A chain as deep as the outline allows, every block linking one page
    and carrying a long text: each backlink's trail is the whole chain
    above it. Sending the trail's texts on every item made the response
    about depth²/2 copies of the stored text (96 MiB from 1.9 MiB); each
    ancestor's text now travels once, in `ancestor_texts`."""
    from pkm.contracts.ops import MAX_OUTLINE_DEPTH
    filler = "x" * 20_000
    uids = [f"amp{i:07d}" for i in range(MAX_OUTLINE_DEPTH)]
    texts = [f"[[Amp Target]] {i} {filler}" for i in range(len(uids))]
    ops = [{"op": "create", "uid": uid, "page_title": "Amp Chain",
            "parent_uid": uids[i - 1] if i else None, "order_idx": 0,
            "text": texts[i]} for i, uid in enumerate(uids)]
    for n, start in enumerate(range(0, len(ops), 10)):
        r = client.post("/api/ops", json={
            "client_id": "amp", "batch_id": f"batch_amp{n:05d}",
            "ops": ops[start:start + 10]})
        assert r.status_code == 200, r.text
    stored = sum(len(t) for t in texts)

    r = client.get("/api/page/Amp Target", params={"bl_limit": 100})

    assert r.status_code == 200
    assert len(r.content) < 3 * stored
    bl = r.json()["backlinks"]
    [group] = bl["groups"]
    deepest = next(i for i in group["items"] if i["uid"] == uids[-1])
    assert deepest["ancestor_uids"] == uids[:-1]
    assert [bl["ancestor_texts"][u] for u in deepest["ancestor_uids"]] \
        == texts[:-1]
