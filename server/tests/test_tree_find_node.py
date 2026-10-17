from pkm.contracts.ops import BlockUid, OrderIdx
from pkm.rows import Row
from pkm.server.tree import build_tree, find_node


def _row(uid: str, parent: str | None, text: str) -> Row:
    return {"uid": BlockUid(uid),
            "parent_uid": BlockUid(parent) if parent else None,
            "order_idx": OrderIdx(0), "text": text, "heading": None,
            "collapsed": 0, "created_at": None, "updated_at": None,
            "view_type": None}


ROWS = [
    _row("r1", None, "root"),
    _row("c1", "r1", "child"),
    _row("g1", "c1", "grandchild"),
]


def test_find_node_returns_nested_subtree():
    node = find_node(build_tree(ROWS), BlockUid("c1"))
    assert node is not None
    assert node["text"] == "child"
    assert node["children"][0]["uid"] == "g1"


def test_find_node_missing_uid_returns_none():
    assert find_node(build_tree(ROWS), BlockUid("nope")) is None
