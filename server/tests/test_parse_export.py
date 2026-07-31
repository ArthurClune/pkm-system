import pytest

from pkm.edn import parse_edn
from pkm.importer.parse_export import parse_export

EXPORT = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Machine Learning" 536870913]
  [1 :block/uid "uid-page1x" 536870913]
  [1 :create/time 1600000000000 536870913]
  [1 :edit/time 1600000001000 536870913]
  [1 :block/children 3 536870913]
  [1 :block/children 2 536870913]
  [2 :block/uid "uid-2xxxx" 536870913]
  [2 :block/string "second (order 1)" 536870913]
  [2 :block/order 1 536870913]
  [3 :block/uid "uid-3xxxx" 536870913]
  [3 :block/string "first (order 0)" 536870913]
  [3 :block/order 0 536870913]
  [3 :block/heading 2 536870913]
  [3 :children/view-type :numbered 536870913]
  [3 :block/open false 536870913]
  [3 :block/children 4 536870913]
  [4 :block/uid "uid-4xxxx" 536870913]
  [4 :block/string "nested child" 536870913]
  [4 :block/order 0 536870913]
  [4 :edit/time 1600000002000 536870913]
  [5 :block/uid "uid-orphan" 536870913]
  [5 :block/string "unreachable" 536870913]
  [6 :block/uid "uid-empty" 536870913]
  [2 :block/refs 1 536870913]
 ]}"""


def test_tree_shape_and_ordering():
    export = parse_export(parse_edn(EXPORT))
    assert len(export.pages) == 1
    page = export.pages[0]
    assert page.title == "Machine Learning"
    assert page.created_at == 1600000000000
    assert [b.text for b in page.children] == ["first (order 0)", "second (order 1)"]
    first = page.children[0]
    assert first.heading == 2
    assert first.view_type == "numbered"
    assert first.open is False
    assert first.children[0].uid == "uid-4xxxx"
    assert first.children[0].edited_at == 1600000002000


def test_orphans_skips_and_attr_counts():
    export = parse_export(parse_edn(EXPORT))
    assert export.orphan_block_count == 1      # uid-orphan
    assert export.skipped_entities == 1        # eid 6: uid but no string
    assert export.attr_counts[":block/refs"] == 1
    assert export.attr_counts[":node/title"] == 1


def test_rejects_non_datascript_value():
    with pytest.raises(ValueError):
        parse_export({"not": "a db"})


def test_single_orphan_block_is_recoverable():
    # orphan_block_count alone used to be the only trace of a dropped
    # block; orphan_blocks must carry the actual uid/text/children so the
    # importer can recover it rather than discard it.
    export = parse_export(parse_edn(EXPORT))
    assert len(export.orphan_blocks) == 1
    orphan = export.orphan_blocks[0]
    assert orphan.uid == "uid-orphan"
    assert orphan.text == "unreachable"
    assert orphan.children == ()


NESTED_ORPHAN_EXPORT = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Page" 1]
  [1 :block/children 2 1]
  [2 :block/uid "uid-page-child" 1]
  [2 :block/string "reachable" 1]
  [2 :block/order 0 1]
  [10 :block/uid "uid-orphan-root" 1]
  [10 :block/string "orphan root" 1]
  [10 :block/children 11 1]
  [11 :block/uid "uid-orphan-child" 1]
  [11 :block/string "orphan child" 1]
  [11 :block/order 0 1]
 ]}"""


def test_orphan_subtree_structure_is_preserved():
    # A chain of unreachable blocks must surface as ONE root orphan with
    # its child nested inside -- not two independent top-level orphans,
    # and not a flattened list that loses the parent/child relationship.
    export = parse_export(parse_edn(NESTED_ORPHAN_EXPORT))
    assert export.orphan_block_count == 2  # root + child
    assert len(export.orphan_blocks) == 1
    root = export.orphan_blocks[0]
    assert root.uid == "uid-orphan-root"
    assert root.text == "orphan root"
    assert len(root.children) == 1
    assert root.children[0].uid == "uid-orphan-child"
    assert root.children[0].text == "orphan child"


def test_no_orphans_is_an_empty_tuple():
    raw = NESTED_ORPHAN_EXPORT.replace(
        '[10 :block/uid "uid-orphan-root" 1]\n  [10 :block/string "orphan root" 1]\n'
        '  [10 :block/children 11 1]\n  [11 :block/uid "uid-orphan-child" 1]\n'
        '  [11 :block/string "orphan child" 1]\n  [11 :block/order 0 1]\n', '')
    export = parse_export(parse_edn(raw))
    assert export.orphan_blocks == ()
    assert export.orphan_block_count == 0


STRINGLESS_PARENT_EXPORT = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Page" 1]
  [1 :block/children 2 1]
  [2 :block/uid "uid-page-child" 1]
  [2 :block/string "reachable" 1]
  [2 :block/order 0 1]
  [20 :block/uid "uid-skipped-parent" 1]
  [20 :block/children 21 1]
  [21 :block/uid "uid-real-orphan-child" 1]
  [21 :block/string "real orphan child text" 1]
  [21 :block/order 0 1]
 ]}"""


def test_orphan_under_a_stringless_parent_is_still_recovered():
    # Entity 20 has a uid but no :block/string -- one of skipped_entities.
    # is_block() fails on it, so build() returns None WITHOUT recursing
    # into its :block/children at all, meaning entity 21 (a real,
    # text-bearing block) is never visited from any page walk. The old
    # child_of_any exclusion then treated 21 as "somebody's child" and
    # refused to root it, dropping its text entirely. It must surface as
    # its own orphan root instead.
    export = parse_export(parse_edn(STRINGLESS_PARENT_EXPORT))
    assert export.skipped_entities == 1
    assert export.orphan_block_count == 1
    assert len(export.orphan_blocks) == 1
    recovered = export.orphan_blocks[0]
    assert recovered.uid == "uid-real-orphan-child"
    assert recovered.text == "real orphan child text"


CYCLIC_ORPHAN_EXPORT = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Page" 1]
  [1 :block/children 2 1]
  [2 :block/uid "uid-page-child" 1]
  [2 :block/string "reachable" 1]
  [2 :block/order 0 1]
  [30 :block/uid "uid-cycle-a" 1]
  [30 :block/string "cycle A" 1]
  [30 :block/children 31 1]
  [31 :block/uid "uid-cycle-b" 1]
  [31 :block/string "cycle B" 1]
  [31 :block/children 30 1]
 ]}"""


def _collect_uids(blocks) -> set[str]:
    uids: set[str] = set()
    for b in blocks:
        uids.add(b.uid)
        uids |= _collect_uids(b.children)
    return uids


def _count_blocks(blocks) -> int:
    return sum(1 + _count_blocks(b.children) for b in blocks)


def test_cyclic_orphan_group_is_recovered_not_dropped():
    # A <-> B, unreachable from any page: under the old child_of_any rule
    # BOTH nodes are "somebody's child" (each points to the other), so
    # neither qualified as a root and both were silently dropped. build()'s
    # existing ancestor-trail cycle guard should let one become the root
    # with the other nested beneath it, losing only the redundant
    # back-edge, not either block's content.
    export = parse_export(parse_edn(CYCLIC_ORPHAN_EXPORT))
    assert export.orphan_block_count == 2
    assert _collect_uids(export.orphan_blocks) == {"uid-cycle-a", "uid-cycle-b"}


CYCLE_WITH_BRANCH_EXPORT = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Page" 1]
  [1 :block/children 2 1]
  [2 :block/uid "uid-page-child" 1]
  [2 :block/string "reachable" 1]
  [2 :block/order 0 1]
  [40 :block/uid "uid-cycle-a2" 1]
  [40 :block/string "cycle A2" 1]
  [40 :block/children 41 1]
  [40 :block/children 42 1]
  [41 :block/uid "uid-cycle-b2" 1]
  [41 :block/string "cycle B2" 1]
  [41 :block/order 0 1]
  [41 :block/children 40 1]
  [42 :block/uid "uid-a-branch-child" 1]
  [42 :block/string "branch child text" 1]
  [42 :block/order 1 1]
 ]}"""


def test_cycle_with_a_hanging_branch_is_not_double_counted():
    # A <-> B, with A also parenting a non-cyclic child C whose uid sorts
    # alphabetically *before* both cycle members ("uid-a-branch-child" <
    # "uid-cycle-a2"). A naive "sort unreached eids by uid, root whichever
    # isn't built yet" would hit C first, wrongly root it standalone
    # (missing A and B entirely), and then -- when it later reaches A --
    # attach the already-built C a second time as A's real child,
    # emitting uid-a-branch-child twice (an IntegrityError against the
    # blocks table's uid primary key in the full importer). Rooting must
    # land on the cycle itself so the whole component comes back in one
    # subtree, with C nested under its real parent exactly once.
    export = parse_export(parse_edn(CYCLE_WITH_BRANCH_EXPORT))
    assert export.orphan_block_count == 3
    assert len(export.orphan_blocks) == 1
    assert _count_blocks(export.orphan_blocks) == 3
    assert _collect_uids(export.orphan_blocks) == {
        "uid-cycle-a2", "uid-cycle-b2", "uid-a-branch-child"}
    root = export.orphan_blocks[0]
    assert root.uid == "uid-cycle-a2"
    branch_child = next(b for b in root.children if b.uid == "uid-a-branch-child")
    assert branch_child.text == "branch child text"


def test_orphan_block_count_matches_total_recovered_blocks():
    # The report claims "recovered to '<page>': N" -- N must be exactly how
    # many blocks actually land on that page, across every export shape
    # exercised in this file.
    for raw in (EXPORT, NESTED_ORPHAN_EXPORT, STRINGLESS_PARENT_EXPORT,
                CYCLIC_ORPHAN_EXPORT, CYCLE_WITH_BRANCH_EXPORT):
        export = parse_export(parse_edn(raw))
        assert _count_blocks(export.orphan_blocks) == export.orphan_block_count


def test_unknown_children_view_type_is_ignored():
    raw = EXPORT.replace(":children/view-type :numbered",
                         ":children/view-type :kanban")
    export = parse_export(parse_edn(raw))
    assert export.pages[0].children[0].view_type is None


def test_document_children_view_type_is_imported():
    raw = EXPORT.replace(":children/view-type :numbered",
                         ":children/view-type :document")
    export = parse_export(parse_edn(raw))
    assert export.pages[0].children[0].view_type == "document"
