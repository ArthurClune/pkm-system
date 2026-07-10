import pytest

from pkm.edn import EdnError, Tagged, parse_edn


def test_datascript_dump_shape():
    src = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref,
                                                       :db/cardinality :db.cardinality/many}}
                             :datoms [[1 :node/title "AI" 536870913]
                                      [1 :block/children 2 536870913]
                                      [2 :block/string "hi \\"there\\"\\nline2" 536870913]
                                      [2 :block/open false 536870913]
                                      [2 :edit/time 1600000000000 536870913]]}"""
    db = parse_edn(src)
    assert isinstance(db, Tagged) and db.tag == "datascript/DB"
    assert isinstance(db.value, dict)
    schema = db.value[":schema"]
    assert schema[":block/children"][":db/cardinality"] == ":db.cardinality/many"
    datoms = db.value[":datoms"]
    assert datoms[0] == [1, ":node/title", "AI", 536870913]
    assert datoms[2][2] == 'hi "there"\nline2'
    assert datoms[3][2] is False
    assert datoms[4][2] == 1600000000000


def test_atoms_and_collections():
    assert parse_edn("nil") is None
    assert parse_edn("true") is True
    assert parse_edn("[1 -2 3.5]") == [1, -2, 3.5]
    assert parse_edn("#{1 2}") == [1, 2]
    assert parse_edn('{"k" (1 2)}') == {"k": [1, 2]}
    assert parse_edn(':a/b') == ":a/b"
    assert parse_edn('"\\u00e9"') == "é"
    assert parse_edn('#uuid "abc"') == Tagged("uuid", "abc")


def test_comments_commas_discard():
    assert parse_edn("[1, 2 ; comment\n 3 #_ 99 4]") == [1, 2, 3, 4]


def test_errors():
    with pytest.raises(EdnError):
        parse_edn('"unterminated')
    with pytest.raises(EdnError):
        parse_edn("{:a}")
    with pytest.raises(EdnError):
        parse_edn("[1] trailing")
    with pytest.raises(EdnError):
        parse_edn("#")
    with pytest.raises(EdnError):
        parse_edn('{[1] "v"}')
