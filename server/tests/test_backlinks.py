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
    # uid_b3 is nested under uid_b2 ("Papers") — backlinks of "Paper" show the chain
    body = client.get("/api/page/Paper").json()
    [group] = body["backlinks"]["groups"]
    assert group["page_title"] == "Machine Learning"
    [item] = group["items"]
    assert item["uid"] == "uid_b3"
    assert item["breadcrumbs"] == ["Papers"]


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
    unlinked references already skip the current page (pkm-r747)."""
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
