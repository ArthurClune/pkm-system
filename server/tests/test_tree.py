from pkm.contracts.ops import BlockUid, ViewType
from pkm.rows import Row, StoredHeadingLevel
from pkm.contracts.responses import BlockNode
from pkm.server.tree import build_tree, collect_block_ref_uids
from pkm.test_data.ids import order_idx_of, uid_of


def _row(uid: BlockUid, parent: BlockUid | None, idx: int, text: str,
         heading: StoredHeadingLevel | None, view_type: ViewType | None,
         collapsed: int) -> Row:
    return {"uid": uid,
            "parent_uid": parent,
            "order_idx": order_idx_of(idx), "text": text, "heading": heading,
            "view_type": view_type, "collapsed": collapsed,
            "created_at": None, "updated_at": None}


ROWS = [
    _row(uid_of("tuid-r2"), None, 1, "second", 2, "numbered", 1),
    _row(uid_of("tuid-r1"), None, 0, "first", None, None, 0),
    _row(uid_of("tuid-c1"), uid_of("tuid-r2"), 0, "child", None, "document", 0),
    _row(uid_of("tuid-ghost"), uid_of("missing"), 0, "orphan", None, None, 0),
]


def test_build_tree_nests_and_sorts():
    tree = build_tree(ROWS)
    assert [n.text for n in tree] == ["first", "second", "orphan"]
    assert tree[1].heading == 2 and tree[1].collapsed is True
    assert tree[1].view_type == "numbered"
    assert [c.text for c in tree[1].children] == ["child"]
    assert tree[1].children[0].view_type == "document"


def test_build_tree_returns_block_nodes():
    tree = build_tree(ROWS)
    assert all(isinstance(n, BlockNode) for n in tree)
    assert tree[1].children[0].uid == "tuid-c1"


def test_collect_block_ref_uids():
    texts = ["see ((abc123XYZ)) and ((abc123XYZ))", "plain", "((zz99_-foo))"]
    assert collect_block_ref_uids(texts) == ["abc123XYZ", "zz99_-foo"]


def test_build_tree_exposes_order_idx():
    tree = build_tree(ROWS)
    assert [n.order_idx for n in tree] == [0, 1, 0]
    assert tree[1].children[0].order_idx == 0


def test_tree_collapsed_is_bool():
    tree = build_tree(ROWS)
    assert tree[1].collapsed is True
    assert tree[0].collapsed is False


def test_build_tree_reads_a_legacy_heading_zero_as_none():
    (node,) = build_tree([_row(uid_of("tuid-h0"), None, 0, "legacy", 0, None, 0)])
    assert node.heading is None
