from pkm.contracts.ops import BlockUid, HeadingLevel, OrderIdx, ViewType
from pkm.rows import Row
from pkm.server.tree import build_tree, collect_block_ref_uids


def _row(uid: str, parent: str | None, idx: int, text: str,
         heading: HeadingLevel | None, view_type: ViewType | None,
         collapsed: int) -> Row:
    return {"uid": BlockUid(uid),
            "parent_uid": BlockUid(parent) if parent else None,
            "order_idx": OrderIdx(idx), "text": text, "heading": heading,
            "view_type": view_type, "collapsed": collapsed,
            "created_at": None, "updated_at": None}


ROWS = [
    _row("r2", None, 1, "second", 2, "numbered", 1),
    _row("r1", None, 0, "first", None, None, 0),
    _row("c1", "r2", 0, "child", None, "document", 0),
    _row("ghost", "missing", 0, "orphan", None, None, 0),
]


def test_build_tree_nests_and_sorts():
    tree = build_tree(ROWS)
    assert [n["text"] for n in tree] == ["first", "second", "orphan"]
    assert tree[1]["heading"] == 2 and tree[1]["collapsed"] == 1
    assert tree[1]["view_type"] == "numbered"
    assert [c["text"] for c in tree[1]["children"]] == ["child"]
    assert tree[1]["children"][0]["view_type"] == "document"


def test_collect_block_ref_uids():
    texts = ["see ((abc123XYZ)) and ((abc123XYZ))", "plain", "((zz99_-foo))"]
    assert collect_block_ref_uids(texts) == ["abc123XYZ", "zz99_-foo"]


def test_build_tree_exposes_order_idx():
    tree = build_tree(ROWS)
    assert [n["order_idx"] for n in tree] == [0, 1, 0]
    assert tree[1]["children"][0]["order_idx"] == 0


def test_tree_collapsed_is_bool():
    tree = build_tree(ROWS)
    assert tree[1]["collapsed"] is True
    assert tree[0]["collapsed"] is False
