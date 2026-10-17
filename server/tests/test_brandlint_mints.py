from pathlib import Path

import pytest

from brandlint.core import RULES, check_text
from brandlint.registry import load_registry

REPO = Path(__file__).resolve().parents[2]
REGISTRY = load_registry(REPO)
ROUTES = "server/src/pkm/routes_pages.py"
STORE = "server/src/pkm/store.py"
CONTRACT = "server/src/pkm/contracts/ops.py"
DATABASE = "server/src/pkm/database.py"


def rules(text: str, path: str = STORE) -> list[str]:
    return [v.rule for v in check_text(path, text, REGISTRY)]


def test_minting_a_brand_outside_its_sites_is_flagged():
    assert rules("x = BlockUid(raw)\n", ROUTES) == ["brand-mint"]


def test_minting_through_a_module_attribute_is_flagged():
    assert rules("x = ops.PageId(raw)\n", ROUTES) == ["brand-mint"]


def test_minting_at_a_registered_site_is_clean():
    assert rules("x = BlockUid(raw)\n", CONTRACT) == []
    assert rules("x = BlockUid(raw)\n", "server/src/pkm/batch.py") == []


def test_a_brand_may_be_minted_in_the_file_that_declares_it():
    declared = 'Local = NewType("Local", str)\nx = Local(raw)\n'
    assert rules(declared, ROUTES) == []


def test_the_declaration_itself_is_not_a_mint():
    assert rules('BlockUid = NewType("BlockUid", str)\n', ROUTES) == []


def test_a_name_that_is_not_a_brand_is_not_a_mint():
    assert rules("x = Path(raw)\n", ROUTES) == []


def test_the_mint_remedy_names_the_fix():
    assert "parse" in RULES["brand-mint"]


@pytest.mark.parametrize("source", [
    "x = cast(BlockUid, raw)",
    "x = cast(Row, raw)",
    "x = typing.cast(PageId, 1)",
])
def test_a_cast_outside_the_cast_sites_is_flagged(source: str):
    assert rules(source + "\n", ROUTES) == ["brand-cast"]


def test_a_cast_at_a_cast_site_is_clean():
    assert rules("x = cast(Row, raw)\n", DATABASE) == []


def test_model_construct_is_flagged_everywhere_in_scope():
    assert rules("m = Model.model_construct(a=1)\n", ROUTES) == ["model-construct"]
    assert rules("m = Model.model_construct(a=1)\n", DATABASE) == ["model-construct"]


@pytest.mark.parametrize("source", [
    "con = sqlite3.connect(path)",
    "con.cursor()",
    "def f(c: sqlite3.Connection): ...",
    "def f(c: sqlite3.Cursor): ...",
    "db.raw.execute('select 1')",
])
def test_raw_sqlite_outside_database_is_flagged(source: str):
    assert rules(source + "\n") == ["raw-sqlite"]


@pytest.mark.parametrize("source", [
    "con = sqlite3.connect(path)",
    "db.raw.execute('select 1')",
    "cur = con.cursor()",
])
def test_raw_sqlite_in_database_is_clean(source: str):
    assert rules(source + "\n", DATABASE) == []


def test_sqlite_exception_classes_are_not_raw_access():
    assert rules("try:\n    pass\nexcept sqlite3.IntegrityError:\n    pass\n") == []


def test_test_support_and_other_trees_are_exempt():
    text = "x = BlockUid(raw)\ny = cast(Row, z)\ndb.raw\n"
    assert rules(text, "server/src/pkm/test_data/core.py") == []
    assert rules(text, "server/tests/test_x.py") == []
    assert rules(text, "server/tooling/perfcheck/backend.py") == []


def test_each_remedy_names_the_fix():
    assert "select()" in RULES["brand-cast"]
    assert "model_validate" in RULES["model-construct"]
    assert "Db" in RULES["raw-sqlite"]


def test_the_violation_names_the_site():
    [v] = check_text(STORE, "x = 1\ndb.raw\n", REGISTRY)
    assert (v.path, v.line, v.rule) == (STORE, 2, "raw-sqlite")
