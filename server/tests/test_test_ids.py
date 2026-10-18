from pathlib import Path

import pytest

import rawread
from pkm.brand_registry import MALFORMED, SHAPES, TEST_HELPERS, WEB_BRANDS
from pkm.database import Db, connect
from pkm.server.query import QueryNode
from pkm.test_data import ids

SHA = "0" * 64


def test_uid_of_returns_a_uid_shaped_value():
    assert ids.uid_of("tuid-a") == "tuid-a"


@pytest.mark.parametrize("value", ["a", "", "has space!"])
def test_uid_of_rejects_a_malformed_uid_and_names_malformed_uid(value: str):
    with pytest.raises(ValueError, match="malformed_uid"):
        ids.uid_of(value)


def test_malformed_uid_returns_the_value_unchecked():
    assert ids.malformed_uid("") == ""


def test_sha_of_checks_the_shape():
    assert ids.sha_of(SHA) == SHA
    with pytest.raises(ValueError, match="malformed_sha"):
        ids.sha_of("zz")
    assert ids.malformed_sha("zz") == "zz"


def test_page_id_of_takes_an_int():
    assert ids.page_id_of(3) == 3


@pytest.mark.parametrize("value", [True, 1.5, "3"])
def test_page_id_of_rejects_a_bool_a_float_or_a_string(value: object):
    with pytest.raises(ValueError, match="PageId"):
        ids.page_id_of(value)  # pyrefly: ignore[bad-argument-type]


@pytest.mark.parametrize("value", [3, None])
def test_a_text_helper_rejects_a_non_string(value: object):
    with pytest.raises(ValueError, match="ClientId"):
        ids.client_id_of(value)  # pyrefly: ignore[bad-argument-type]


def test_malformed_seq_returns_the_value_unchecked():
    with pytest.raises(ValueError, match="SyncSeq"):
        ids.seq_of(1.5)  # pyrefly: ignore[bad-argument-type]
    assert ids.malformed_seq(1.5) == 1.5  # pyrefly: ignore[bad-argument-type]


def test_malformed_helpers_pass_none_through():
    assert ids.malformed_uid(None) is None  # pyrefly: ignore[bad-return]
    assert ids.malformed_canonical_title(None) is None  # pyrefly: ignore[bad-return]
    assert ids.malformed_seq(None) is None  # pyrefly: ignore[bad-return]


def test_every_shaped_brand_has_a_malformed_helper():
    shaped = {brand for brand, (_, pattern) in SHAPES.items() if pattern is not None}
    assert shaped <= set(MALFORMED)


def test_every_test_helper_exists():
    for brand, stem in TEST_HELPERS.items():
        if brand not in WEB_BRANDS:
            assert callable(getattr(ids, f"{stem}_of", None)), brand
    for stem in MALFORMED.values():
        assert callable(getattr(ids, f"malformed_{stem}", None)), stem


# A valid value for every server helper, so each one is seen to pass.
VALID = {
    "uid_of": "tuid-a", "page_id_of": 1, "sidebar_entry_id_of": 2,
    "order_idx_of": 3, "sidebar_order_idx_of": 4, "seq_of": 5,
    "client_id_of": "client-1", "batch_id_of": "batch-1", "sha_of": SHA,
    "conversation_id_of": "conv-1", "confirm_id_of": "confirm-1",
    "goodlinks_id_of": "gl-1", "normalized_title_of": "a title",
    "canonical_title_of": "A Title",
    "canonical_query_node_of": QueryNode("page", "a"),
}


def test_every_server_helper_returns_its_value():
    helpers = {f"{stem}_of" for brand, stem in TEST_HELPERS.items()
               if brand not in WEB_BRANDS}
    assert helpers == set(VALID)
    for name, value in VALID.items():
        assert getattr(ids, name)(value) == value


def test_the_query_node_helper_rejects_another_type():
    with pytest.raises(ValueError, match="CanonicalQueryNode"):
        ids.canonical_query_node_of("page")  # pyrefly: ignore[bad-argument-type]


def _db(tmp_path: Path) -> Db:
    db = connect(tmp_path / "t.db")
    db.executescript("CREATE TABLE blocks(uid TEXT, text TEXT);"
                     "INSERT INTO blocks VALUES ('tuid-a', 'hello');"
                     "CREATE TABLE pages(id INTEGER, title TEXT);"
                     "CREATE TABLE sidebar_entries(id INTEGER, order_idx INTEGER);")
    return db


@pytest.mark.parametrize("sql, message", [
    ("SELECT uid FROM blocks", "uid carries BlockUid: read it with Db.select"),
    ("SELECT * FROM blocks", "uid carries BlockUid"),
    ("SELECT id FROM pages", "id carries PageId"),
    ("SELECT id FROM sidebar_entries", "id carries .*SidebarEntryId"),
    ("SELECT order_idx FROM sidebar_entries", "order_idx carries OrderIdx or SidebarOrderIdx"),
])
def test_rawread_refuses_brand_columns(tmp_path: Path, sql: str, message: str):
    with pytest.raises(AssertionError, match=message):
        rawread.read(_db(tmp_path), sql)


def test_rawread_reads_counts_and_unbranded_columns(tmp_path: Path):
    db = _db(tmp_path)
    assert rawread.read(db, "SELECT count(*) AS n FROM blocks").fetchone()["n"] == 1
    assert rawread.read(db, "SELECT text FROM blocks").fetchall() == [("hello",)]
