import pytest

from pkm.server.db import open_db
from pkm.server.query import QueryParseError, parse_query


def test_parse_simple_and():
    node = parse_query("{and: [[Paper]] [[Attention Is All You Need]]}")
    assert node.kind == "and"
    assert [c.title for c in node.children] == \
        ["Paper", "Attention Is All You Need"]


def test_parse_nested_or_and_not():
    node = parse_query("{and: [[A]] {or: [[B]] [[C]]} {not: [[D]]}}")
    kinds = [c.kind for c in node.children]
    assert kinds == ["page", "or", "not"]
    assert [c.title for c in node.children[1].children] == ["B", "C"]
    assert node.children[2].children[0].title == "D"


def test_parse_nested_bracket_title():
    node = parse_query("{and: [[A [[B]] c]]}")
    assert node.children[0].title == "A [[B]] c"


@pytest.mark.parametrize("bad,msg", [
    ("{between: [[A]] [[B]]}", "unsupported clause: between"),
    ("{not: [[A]]}", "not"),
    ("{and: }", "empty"),
    ("[[A]] [[B]]", "expected"),
])
def test_parse_errors(bad, msg):
    with pytest.raises(QueryParseError, match=msg):
        parse_query(bad)


def test_query_endpoint_and(client):
    r = client.get("/api/query",
                   params={"expr": "{and: [[Paper]] [[Attention Is All You Need]]}"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    [group] = body["groups"]
    assert group["page_title"] == "Machine Learning"
    assert [i["uid"] for i in group["items"]] == ["uid_b3"]


def test_query_endpoint_or_and_not(client):
    body = client.get("/api/query",
                      params={"expr": "{or: [[Paper]] [[Machine Learning]]}"}).json()
    assert {i["uid"] for g in body["groups"] for i in g["items"]} == {"uid_b3", "uid_b4"}
    body = client.get(
        "/api/query",
        params={"expr": "{and: [[Paper]] {not: [[Attention Is All You Need]]}}"},
    ).json()
    assert body["total"] == 0


def test_query_endpoint_excludes_query_source_blocks(client, seeded_config):
    con = open_db(seeded_config.db_path)
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        ("uid_query", 1, None, 2,
         "{{[[query]]: {and: [[Paper]] [[Attention Is All You Need]]}}}",
         None, 0, None, None),
    )
    con.executemany("INSERT INTO refs VALUES (?,?,?)", [
        ("uid_query", 4, "link"),
        ("uid_query", 5, "link"),
    ])
    con.commit()
    con.close()

    body = client.get(
        "/api/query",
        params={"expr": "{and: [[Paper]] [[Attention Is All You Need]]}"},
    ).json()

    assert body["total"] == 1
    assert [i["uid"] for g in body["groups"] for i in g["items"]] == ["uid_b3"]


def test_query_endpoint_returns_every_match(client, seeded_config):
    con = open_db(seeded_config.db_path)
    blocks = [
        (f"uid_many_{i:03d}", 1, None, i + 10, f"result {i} [[Paper]]",
         None, 0, None, None)
        for i in range(101)
    ]
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading,"
        " collapsed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        blocks,
    )
    con.executemany(
        "INSERT INTO refs VALUES (?,?,?)",
        [(uid, 4, "link") for uid, *_ in blocks],
    )
    con.commit()
    con.close()

    body = client.get(
        "/api/query", params={"expr": "{and: [[Paper]]}"},
    ).json()
    items = [item for group in body["groups"] for item in group["items"]]

    # 101 inserted matches plus seeded uid_b3. This exceeds the old default
    # limit of 100 and proves the endpoint returns the complete result set.
    assert body["total"] == 102
    assert len(items) == 102
    assert {item["uid"] for item in items} >= {"uid_many_000", "uid_many_100"}


def test_query_endpoint_bad_expr_400(client):
    r = client.get("/api/query", params={"expr": "{between: [[A]] [[B]]}"})
    assert r.status_code == 400
    assert "unsupported clause" in r.json()["detail"]
