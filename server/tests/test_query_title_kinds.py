"""Type probes: a query tree's title type says its kind.

Each `pyrefly: ignore` marks an error that must stay an error (pyrefly warns
if one stops firing); each `assert_type` pins a type that must hold.
"""
from typing import assert_type

from pkm.contracts.titles import CanonicalTitle, RawTitle
from pkm.server.query import QueryNode, page_operands, parse_query, plan_sql
from pkm.test_data.ids import canonical_title_of, raw_title_of


def test_a_parsed_tree_is_raw_and_its_operands_are_raw_titles():
    node = parse_query("{and: [[A]] [[B]]}")
    assert_type(node, QueryNode[RawTitle])
    assert_type(page_operands(node), list[RawTitle])
    assert page_operands(node) == ["A", "B"]


def test_a_canonical_tree_gives_canonical_operands_and_plans():
    node = QueryNode[CanonicalTitle]("page", canonical_title_of("A"))
    assert_type(page_operands(node), list[CanonicalTitle])
    assert plan_sql(node)[1] == ["A"]


def test_a_raw_tree_does_not_plan():
    raw = parse_query("{and: [[A]] [[B]]}")
    plan_sql(raw)  # pyrefly: ignore[bad-argument-type]
    by_hand = QueryNode[RawTitle]("page", raw_title_of("A"))
    plan_sql(by_hand)  # pyrefly: ignore[bad-argument-type]


def test_a_canonical_node_does_not_take_a_raw_title():
    QueryNode[CanonicalTitle](
        "page", raw_title_of("A"))  # pyrefly: ignore[bad-argument-type]
