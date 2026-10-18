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
    "from sqlite3 import connect",
    "from sqlite3 import Connection",
    "from sqlite3 import Cursor as C",
    "from sqlite3 import IntegrityError, connect",
    "import sqlite3 as sq",
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


@pytest.mark.parametrize("source", [
    "from sqlite3 import connect",
    "import sqlite3 as sq",
])
def test_raw_sqlite_imports_in_database_are_clean(source: str):
    assert rules(source + "\n", DATABASE) == []


@pytest.mark.parametrize("source", [
    "import sqlite3\ntry:\n    pass\nexcept sqlite3.IntegrityError:\n    pass",
    "from sqlite3 import IntegrityError",
])
def test_importing_sqlite_for_its_errors_is_clean(source: str):
    assert rules(source + "\n") == []


def test_sqlite_exception_classes_are_not_raw_access():
    assert rules("try:\n    pass\nexcept sqlite3.IntegrityError:\n    pass\n") == []


def test_test_support_and_other_trees_are_exempt():
    text = "x = BlockUid(raw)\ny = cast(Row, z)\ndb.raw\n"
    assert rules(text, "server/src/pkm/test_data/core.py") == []
    assert rules(text, "server/tests/test_x.py") == []


def test_each_remedy_names_the_fix():
    assert "select()" in RULES["brand-cast"]
    assert "model_validate" in RULES["model-construct"]
    assert "Db" in RULES["raw-sqlite"]


def test_the_violation_names_the_site():
    [v] = check_text(STORE, "x = 1\ndb.raw\n", REGISTRY)
    assert (v.path, v.line, v.rule) == (STORE, 2, "raw-sqlite")


def test_every_declared_newtype_has_a_mint_entry():
    assert REGISTRY.declared  # the scan found the brands
    assert REGISTRY.declared - set(REGISTRY.mint_sites) == set()


def test_an_internal_newtype_is_a_brand_for_rule_2(tmp_path: Path):
    src = tmp_path / "server/src/pkm"
    src.mkdir(parents=True)
    (src / "brand_registry.py").write_text(
        'NAMES = {}\nSHAPES = {}\nMINT_SITES = {}\nCAST_SITES = ()\n'
        'TEST_SUPPORT = ()\nOPT_OUT_FILES = ()\nSQLITE_SITES = {}\n')
    (src / "internal.py").write_text('Hidden = NewType("Hidden", str)\n')
    registry = load_registry(tmp_path)
    assert registry.declared == {"Hidden"}
    assert [v.rule for v in check_text(ROUTES, "x = Hidden(raw)\n", registry)] == ["brand-mint"]


def test_the_canonical_query_node_is_minted_only_in_query_exec():
    assert rules("x = CanonicalQueryNode(n)\n", ROUTES) == ["brand-mint"]
    assert rules("x = CanonicalQueryNode(n)\n", "server/src/pkm/server/query_exec.py") == []


PERFCHECK = "server/tooling/perfcheck/trace.py"
PROPTEST = "server/tooling/proptest/sync_server.py"


def test_server_tooling_is_linted():
    assert rules("x = BlockUid(raw)\n", PROPTEST) == ["brand-mint"]
    assert rules("def f(uid: str): ...\n", PERFCHECK) == ["brand-name"]


def test_perfcheck_may_touch_raw_sqlite_and_proptest_may_not():
    source = "db.raw.set_trace_callback(cb)\n"
    assert rules(source, PERFCHECK) == []
    assert rules(source, PROPTEST) == ["raw-sqlite"]
