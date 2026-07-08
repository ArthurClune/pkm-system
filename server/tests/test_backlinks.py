from pkm.server.backlinks import group_backlinks


def test_group_backlinks_pure():
    rows = [
        dict(uid="x1", text="t1", src_page_id=7, src_page_title="P1"),
        dict(uid="x2", text="t2", src_page_id=7, src_page_title="P1"),
        dict(uid="y1", text="t3", src_page_id=9, src_page_title="P2"),
    ]
    groups = group_backlinks(rows, {"x2": ["root text"]})
    assert [g["page_title"] for g in groups] == ["P1", "P2"]
    assert groups[0]["items"][0] == {"uid": "x1", "text": "t1", "breadcrumbs": []}
    assert groups[0]["items"][1]["breadcrumbs"] == ["root text"]


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
