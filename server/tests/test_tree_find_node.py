from pkm.server.tree import build_tree, find_node

ROWS = [
    {"uid": "r1", "parent_uid": None, "order_idx": 0, "text": "root",
     "heading": None, "collapsed": 0, "created_at": None, "updated_at": None,
     "view_type": None},
    {"uid": "c1", "parent_uid": "r1", "order_idx": 0, "text": "child",
     "heading": None, "collapsed": 0, "created_at": None, "updated_at": None,
     "view_type": None},
    {"uid": "g1", "parent_uid": "c1", "order_idx": 0, "text": "grandchild",
     "heading": None, "collapsed": 0, "created_at": None, "updated_at": None,
     "view_type": None},
]


def test_find_node_returns_nested_subtree():
    node = find_node(build_tree(ROWS), "c1")
    assert node is not None
    assert node["text"] == "child"
    assert node["children"][0]["uid"] == "g1"


def test_find_node_missing_uid_returns_none():
    assert find_node(build_tree(ROWS), "nope") is None
