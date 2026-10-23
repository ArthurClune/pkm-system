
import pytest

from pkm.server.db import open_db
from pkm.server.query import (
    MAX_QUERY_DEPTH, MAX_QUERY_OPERANDS, QueryParseError, parse_query)
from pkm.test_data.ids import canonical_title_of
from pkm.database import connect


def test_parse_simple_and():
    node = parse_query("{and: [[Paper]] [[Attention Is All You Need]]}")
    assert node.kind == "and"
    assert [c.operand for c in node.children] == \
        ["Paper", "Attention Is All You Need"]


def test_parse_nested_or_and_not():
    node = parse_query("{and: [[A]] {or: [[B]] [[C]]} {not: [[D]]}}")
    kinds = [c.kind for c in node.children]
    assert kinds == ["page", "or", "not"]
    assert [c.operand for c in node.children[1].children] == ["B", "C"]
    assert node.children[2].children[0].operand == "D"


def test_parse_nested_bracket_title():
    node = parse_query("{and: [[A [[B]] c]]}")
    assert node.children[0].operand == "A [[B]] c"


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


def test_plan_sql_expand_duplicates_params():
    from pkm.contracts.titles import CanonicalTitle
    from pkm.server.query import QueryNode, plan_sql
    sql, params = plan_sql(
        QueryNode[CanonicalTitle]("page", canonical_title_of("AI")), expand=True)
    assert params == ["AI", "AI"]
    assert "UNION" in sql


def test_query_endpoint_expand_one_hop(client):
    base = client.get("/api/query", params={"expr": "{and: [[AI]]}"}).json()
    assert {i["uid"] for g in base["groups"] for i in g["items"]} == {"uid_b1"}
    body = client.get("/api/query",
                      params={"expr": "{and: [[AI]]}", "expand": "true"}).json()
    assert {i["uid"] for g in body["groups"] for i in g["items"]} == \
        {"uid_b1", "uid_b4"}


def test_page_operands_distinct_first_seen():
    from pkm.server.query import page_operands, parse_query
    node = parse_query("{and: [[A]] {or: [[B]] [[A]]} {not: [[C]]}}")
    assert page_operands(node) == ["A", "B", "C"]


def test_query_endpoint_ref_counts(client):
    body = client.get(
        "/api/query", params={"expr": "{and: [[Paper]] [[AI]]}"}).json()
    assert body["total"] == 0
    assert body["ref_counts"] == {"Paper": 1, "AI": 1}


def test_query_endpoint_operand_with_padded_spaces_matches_canonical_title(
        client, seeded_config):
    """[[ Foo ]] -- spaces inside the brackets, part of the operand slice
    query.py parses -- must still resolve against refs to the canonical
    "Paper", the same page [[Paper]] (no padding) matches, once the
    plain-space migration is active (canonicalize_title only strips edge
    U+0020 under that flag)."""
    con = connect(seeded_config.db_path)
    con.execute(
        "UPDATE sync_meta SET value = '1'"
        " WHERE key = 'plain_space_title_canonicalization'"
    )
    con.commit()
    con.close()

    canonical = client.get("/api/query", params={"expr": "{and: [[Paper]]}"}).json()
    padded = client.get("/api/query", params={"expr": "{and: [[ Paper ]]}"}).json()

    assert padded["total"] == canonical["total"] == 1
    assert padded["groups"] == canonical["groups"]
    # ref_counts is keyed by the canonical title the operand resolved to,
    # not by the raw " Paper " text between the brackets.
    assert padded["ref_counts"] == {"Paper": 1}


def _nested(depth: int) -> str:
    return "{and: " * depth + "[[AI]]" + "}" * depth


def _wide(op: str, n: int) -> str:
    return "{" + op + ": " + " ".join(f"[[t{i}]]" for i in range(n)) + "}"


def test_parse_accepts_the_limit_depth_and_operands():
    assert parse_query(_nested(MAX_QUERY_DEPTH)).kind == "and"
    assert len(parse_query(_wide("or", MAX_QUERY_OPERANDS)).children) \
        == MAX_QUERY_OPERANDS


def test_parse_refuses_over_deep_before_recursing_deep():
    with pytest.raises(QueryParseError, match="deeper than 32 levels"):
        parse_query(_nested(MAX_QUERY_DEPTH + 1))
    # far past the interpreter's recursion limit: refused, not RecursionError
    with pytest.raises(QueryParseError, match="deeper than 32 levels"):
        parse_query(_nested(5000))


def test_parse_refuses_too_many_operands():
    with pytest.raises(QueryParseError, match="more than 200 page operands"):
        parse_query(_wide("or", MAX_QUERY_OPERANDS + 1))
    # operands count across the whole expression, not per clause
    half = " ".join(f"[[a{i}]]" for i in range(MAX_QUERY_OPERANDS // 2 + 1))
    with pytest.raises(QueryParseError, match="more than 200 page operands"):
        parse_query("{and: {or: " + half + "} {or: "
                    + half.replace("a", "b") + "}}")


def test_query_route_answers_400_for_over_deep_and_over_wide(client):
    for expr in (_nested(MAX_QUERY_DEPTH + 1), _nested(496),
                 _wide("or", MAX_QUERY_OPERANDS + 1), _wide("or", 501),
                 _wide("and", 501)):
        r = client.get("/api/query", params={"expr": expr})
        assert r.status_code == 400, expr[:40]
    assert "32 levels" in client.get(
        "/api/query", params={"expr": _nested(33)}).json()["detail"]


def test_query_route_expand_at_the_operand_limit_still_runs(client):
    r = client.get("/api/query", params={
        "expr": _wide("or", MAX_QUERY_OPERANDS), "expand": "true"})
    assert r.status_code == 200
