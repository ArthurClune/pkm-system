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


@pytest.mark.parametrize(
    ("source", "detail", "offset"),
    [
        ("", "unexpected end of input", 0),
        ("{", "unterminated map", 1),
        ("[", "unterminated sequence", 1),
        ('"unterminated', "unterminated string", 13),
        ("{:a}", "map has odd number of forms", 3),
        ('{[1] "value"}', "unhashable map key", 1),
        ('"\\/"', "unsupported escape '\\/'", 1),
        ('"\\u12"', "invalid unicode escape", 3),
        ('"\\ud83d"', "lone surrogate escape", 1),
        ("\\notachar", "unsupported character literal '\\notachar'", 1),
        (")", "unexpected character", 0),
        ("[1]  trailing", "trailing data", 5),
    ],
)
def test_structured_errors(source: str, detail: str, offset: int):
    with pytest.raises(EdnError) as raised:
        parse_edn(source)

    assert raised.value.detail == detail
    assert raised.value.offset == offset
    assert str(raised.value) == f"{detail} at offset {offset}"


def test_solidus_escape_stays_invalid_with_backslash_offset():
    with pytest.raises(EdnError) as raised:
        parse_edn('"\\/"')

    assert raised.value.detail == "unsupported escape '\\/'"
    assert raised.value.offset == 1


def test_unknown_string_escape_raises():
    with pytest.raises(EdnError):
        parse_edn('"\\z"')
    with pytest.raises(EdnError):
        parse_edn('"\\/"')


def test_truncated_unicode_escape_raises():
    with pytest.raises(EdnError):
        parse_edn('"\\u12"')  # only 2 hex digits before closing quote
    with pytest.raises(EdnError):
        parse_edn('"\\u"')  # no hex digits at all
    with pytest.raises(EdnError):
        parse_edn('"\\u12zz"')  # non-hex characters in the escape


def test_unicode_escape_rejects_forms_int_would_otherwise_accept():
    # int(chunk, 16) is lax about signs/whitespace/underscores; a 4-char
    # "hex" chunk must be checked digit-by-digit or these smuggle through
    # (or, for a leading '-', overflow chr() into a raw ValueError).
    with pytest.raises(EdnError):
        parse_edn('"\\u-123"')
    with pytest.raises(EdnError):
        parse_edn('"\\u+12f"')
    with pytest.raises(EdnError):
        parse_edn('"\\u 12f"')
    with pytest.raises(EdnError):
        parse_edn('"\\u1_2f"')


def test_lone_surrogate_escapes_raise():
    with pytest.raises(EdnError):
        parse_edn('"\\ud83d"')  # lone high surrogate, nothing follows
    with pytest.raises(EdnError):
        parse_edn('"\\ud83dX"')  # high surrogate not followed by \\u escape
    with pytest.raises(EdnError):
        parse_edn('"\\udc00"')  # lone low surrogate


def test_surrogate_pair_combines_to_supplementary_codepoint():
    assert parse_edn('"\\ud83d\\ude00"') == "\U0001F600"


def test_discard_forms_at_collection_close():
    assert parse_edn("[1 2 #_3]") == [1, 2]
    assert parse_edn("(1 2 #_3)") == [1, 2]
    assert parse_edn("#{1 2 #_3}") == [1, 2]
    assert parse_edn("{:a 1 #_ :junk}") == {":a": 1}


def test_nested_discard_forms():
    assert parse_edn("[#_ #_ 1 2 3]") == [3]


def test_unsupported_char_literal_raises():
    with pytest.raises(EdnError):
        parse_edn("\\notachar")
    with pytest.raises(EdnError):
        parse_edn("\\")  # trailing backslash, empty char token
