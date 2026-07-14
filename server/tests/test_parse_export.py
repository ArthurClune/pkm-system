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
