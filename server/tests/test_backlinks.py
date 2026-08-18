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
