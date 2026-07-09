from pkm.server.tree import build_tree, collect_block_ref_uids

ROWS = [
    dict(uid="r2", parent_uid=None, order_idx=1, text="second", heading=2,
         collapsed=1, created_at=None, updated_at=None),
    dict(uid="r1", parent_uid=None, order_idx=0, text="first", heading=None,
         collapsed=0, created_at=None, updated_at=None),
    dict(uid="c1", parent_uid="r2", order_idx=0, text="child", heading=None,
         collapsed=0, created_at=None, updated_at=None),
    dict(uid="ghost", parent_uid="missing", order_idx=0, text="orphan",
         heading=None, collapsed=0, created_at=None, updated_at=None),
]


def test_build_tree_nests_and_sorts():
    tree = build_tree(ROWS)
    assert [n["text"] for n in tree] == ["first", "second", "orphan"]
    assert tree[1]["heading"] == 2 and tree[1]["collapsed"] == 1
    assert [c["text"] for c in tree[1]["children"]] == ["child"]


def test_collect_block_ref_uids():
    texts = ["see ((abc123XYZ)) and ((abc123XYZ))", "plain", "((zz99_-foo))"]
    assert collect_block_ref_uids(texts) == ["abc123XYZ", "zz99_-foo"]


def test_build_tree_exposes_order_idx():
    tree = build_tree(ROWS)
    assert [n["order_idx"] for n in tree] == [0, 1, 0]
    assert tree[1]["children"][0]["order_idx"] == 0
