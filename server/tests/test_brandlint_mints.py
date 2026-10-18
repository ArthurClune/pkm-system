from pathlib import Path

import pytest

from brandlint.core import RULES, check_text
from brandlint.registry import declared_newtypes, load_registry

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


@pytest.mark.parametrize("path", ["web/src/x.ts", "server/src/pkm/x.txt", "docs/x.py"])
def test_other_trees_are_not_checked(path: str):
    assert rules("x = BlockUid(raw)\ny = cast(Row, z)\ndb.raw\n", path) == []


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
        'OPT_OUT_FILES = ()\nSQLITE_SITES = {}\nTEST_MINT_SITES = ()\n'
        'TEST_HELPERS = {}\nMALFORMED = {}\nTEST_CODE = ()\n')
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
    for source in ("conn = sqlite3.connect(path)\n",
                   "from sqlite3 import connect\n"):
        assert rules(source, PERFCHECK) == []
        assert rules(source, PROPTEST) == ["raw-sqlite"]


TEST = "server/tests/test_x.py"
TEST_DATA = "server/src/pkm/test_data/core.py"
IDS = "server/src/pkm/test_data/ids.py"


def test_server_tests_are_in_scope():
    assert rules("x = BlockUid(raw)\n", TEST) == ["brand-mint"]
    assert rules("x = BlockUid(raw)\n", TEST_DATA) == ["brand-mint"]


def test_the_test_mint_module_may_mint_every_brand():
    assert rules("a = BlockUid(raw)\nb = PageId(1)\nc = Sha256Hex(raw)\n", IDS) == []


def test_a_mint_in_a_test_names_the_helper():
    [page] = check_text(TEST, "x = PageId(1)\n", REGISTRY)
    assert "page_id_of" in page.text and "pkm.test_data.ids" in page.text
    [uid] = check_text(TEST, 'x = BlockUid("")\n', REGISTRY)
    assert "uid_of" in uid.text and "malformed_uid" in uid.text


def test_a_mint_in_product_code_does_not_name_a_test_helper():
    [v] = check_text(ROUTES, "x = PageId(1)\n", REGISTRY)
    assert "page_id_of" not in v.text


@pytest.mark.parametrize("source", [
    "from pkm.test_data.ids import uid_of",
    "from pkm.test_data import ids",
    "import pkm.test_data.ids as t",
    "import pkm.test_data.ids",
    "from .test_data.ids import uid_of",
    "from .test_data import ids",
])
def test_product_code_may_not_import_the_test_mint_module(source: str):
    assert rules(source + "\n", STORE) == ["test-mint-import"]
    assert rules(source + "\n", TEST) == []


def test_test_data_builders_may_import_the_test_mint_module():
    assert rules("from pkm.test_data.ids import uid_of\n", TEST_DATA) == []
    assert rules("from .ids import uid_of\n", TEST_DATA) == []


def test_other_test_data_imports_are_not_the_mint_module():
    assert rules("from pkm.test_data import core\n", STORE) == []
    assert rules("from pkm.test_data.core import build_rows\n", STORE) == []


def test_an_aliased_brand_import_is_still_a_mint():
    assert rules("from pkm.contracts.ops import BlockUid as U\nx = U(raw)\n", ROUTES) == ["brand-mint"]


@pytest.mark.parametrize("source", [
    "list(map(BlockUid, xs))",
    "sorted(xs, key=PageId)",
    "defaultdict(BlockUid)",
    "list(map(ops.BlockUid, xs))",
])
def test_a_brand_passed_as_a_value_is_a_mint(source: str):
    assert rules(source + "\n", ROUTES) == ["brand-mint"]


@pytest.mark.parametrize("source", [
    "TypeAdapter(list[BlockUid])",
    "TypeAdapter(BlockUid)",
    'NewType("X", BlockUid)',
    "isinstance(x, BlockUid)",
    "cast(BlockUid, x)",
    "assert_type(f(x), Sha256Hex)",
])
def test_a_brand_in_a_type_position_of_a_call_is_not_a_mint(source: str):
    assert "brand-mint" not in rules(source + "\n", ROUTES)


def test_a_brand_passed_as_a_value_at_a_mint_site_is_clean():
    assert rules("list(map(BlockUid, xs))\n", CONTRACT) == []


def test_a_brand_passed_as_a_value_in_a_test_names_the_helper():
    [v] = check_text(TEST, "list(map(PageId, xs))\n", REGISTRY)
    assert v.rule == "brand-mint" and "page_id_of" in v.text


def test_newtype_declared_through_typing_or_indented_is_a_brand(tmp_path: Path):
    src = tmp_path / "server/src/pkm"
    src.mkdir(parents=True)
    (src / "a.py").write_text('import typing\nA = typing.NewType("A", str)\n')
    (src / "b.py").write_text('B: TypeAlias = NewType("B", str)\n')
    (src / "c.py").write_text('if TYPE_CHECKING:\n    C = NewType("C", str)\n')
    assert declared_newtypes(tmp_path) == {"A", "B", "C"}


@pytest.mark.parametrize("declaration", [
    'Local = typing.NewType("Local", str)',
    'Local: TypeAlias = NewType("Local", str)',
    'if True:\n    Local = NewType("Local", str)',
])
def test_a_file_may_mint_a_brand_it_declares_any_way(declaration: str):
    assert rules(declaration + "\nx = Local(raw)\n", ROUTES) == []


IGNORED_CALL = 'SetHeadingOp(op="set_heading", uid="uid_b2", heading=5)  # {comment}\n'


@pytest.mark.parametrize("comment", ["pyrefly: ignore[bad-argument-type]", "type: ignore",
                                     "type: ignore[arg-type]"])
def test_an_ignore_comment_does_not_launder_a_brand_literal(comment: str):
    assert rules(IGNORED_CALL.format(comment=comment), TEST) == ["brand-ignore"]
    helped = IGNORED_CALL.replace('uid="uid_b2"', 'uid=uid_of("uid_b2")')
    assert rules(helped.format(comment=comment), TEST) == []


def test_an_ignore_comment_in_a_multi_line_call_covers_its_span():
    source = ('SetHeadingOp(\n    op="set_heading",\n    uid="uid_b2",\n'
              '    heading=5,  # pyrefly: ignore[bad-argument-type]\n)\n')
    assert rules(source, TEST) == ["brand-ignore"]


def test_an_ignore_comment_without_a_brand_literal_is_clean():
    assert rules('f(title="x", uid=u)  # type: ignore\n', TEST) == []
    assert rules('f(uid=None)  # type: ignore\n', TEST) == []


def test_a_brand_literal_without_an_ignore_comment_is_not_brand_ignore():
    assert rules('f(uid="uid_b2")  # a note\n', TEST) == []


def test_the_ignore_message_names_the_helper_in_a_test():
    [v] = check_text(TEST, IGNORED_CALL.format(comment="type: ignore"), REGISTRY)
    assert "uid_of" in v.text


@pytest.mark.parametrize("source, rule", [
    ("x = cast(Row, raw)", "brand-cast"),
    ("m = Model.model_construct(a=1)", "model-construct"),
    ("db.raw.execute('select 1')", "raw-sqlite"),
    ("con = sqlite3.connect(path)", "raw-sqlite"),
])
def test_cast_model_construct_and_raw_sqlite_apply_in_tests(source: str, rule: str):
    assert rules(source + "\n", TEST) == [rule]


def test_the_test_side_raw_reader_may_touch_raw_sqlite():
    assert rules("con = db.raw\ncur = con.cursor()\n", "server/tests/rawread.py") == []


def test_a_cast_to_a_brand_in_a_test_names_the_helper():
    [v] = check_text(TEST, "x = cast(BlockUid, raw)\n", REGISTRY)
    assert v.rule == "brand-cast" and "uid_of" in v.text


def test_the_new_remedies_name_the_fix():
    assert "pkm.test_data.ids" in RULES["test-mint-import"]
    assert "uid_of" in RULES["brand-ignore"] or "helper" in RULES["brand-ignore"]
