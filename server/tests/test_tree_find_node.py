from pkm.rows import Row
from pkm.server.tree import build_tree, find_node
from pkm.test_data.ids import order_idx_of, uid_of
from pkm.contracts.ops import BlockUid


def _row(uid: BlockUid, parent: BlockUid | None, text: str) -> Row:
    return {"uid": uid,
            "parent_uid": parent,
            "order_idx": order_idx_of(0), "text": text, "heading": None,
            "collapsed": 0, "created_at": None, "updated_at": None,
            "view_type": None}


R1, C1, G1 = uid_of("tuid-r1"), uid_of("tuid-c1"), uid_of("tuid-g1")
ROWS = [
    _row(R1, None, "root"),
    _row(C1, R1, "child"),
    _row(G1, C1, "grandchild"),
]


def test_find_node_returns_nested_subtree():
    node = find_node(build_tree(ROWS), C1)
    assert node is not None
    assert node.text == "child"
    assert node.children[0].uid == G1


def test_find_node_missing_uid_returns_none():
    assert find_node(build_tree(ROWS), uid_of("tuid-nope")) is None
