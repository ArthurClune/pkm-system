import pytest

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


def test_query_endpoint_bad_expr_400(client):
    r = client.get("/api/query", params={"expr": "{between: [[A]] [[B]]}"})
    assert r.status_code == 400
    assert "unsupported clause" in r.json()["detail"]
