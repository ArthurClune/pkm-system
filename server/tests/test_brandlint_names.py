from pathlib import Path

import pytest

from brandlint.core import RULES, check_text
from brandlint.registry import load_registry
from commentlint.core import Violation

REPO = Path(__file__).resolve().parents[2]
REGISTRY = load_registry(REPO)
PRODUCT = "server/src/pkm/store.py"
ROUTES = "server/src/pkm/routes_pages.py"
OPS_CORE = "server/src/pkm/ops_core.py"


def rules(text: str, path: str = PRODUCT) -> list[str]:
    return [v.rule for v in check_text(path, text, REGISTRY)]


@pytest.mark.parametrize("source", [
    "def f(sha: str) -> None: ...",
    "def f(sha: Sha256Hex) -> None: ...",
])
def test_sha_is_a_sha256_name(source: str):
    expected = ["brand-name"] if "str" in source else []
    assert rules(source + "\n") == expected


def test_an_untyped_brand_name_parameter_is_flagged():
    assert rules("def f(uid: str) -> None: ...\n") == ["brand-name"]


@pytest.mark.parametrize("source", [
    "def f(uid: BlockUid) -> None: ...",
    "def f(uid: BlockUid | None) -> None: ...",
    "def f(uids: list[BlockUid]) -> None: ...",
    "def f(uids: Sequence[BlockUid] | None) -> None: ...",
    "def f(uids: tuple[BlockUid, ...]) -> None: ...",
    "def f(uids: frozenset[BlockUid]) -> None: ...",
    "def f(uids: typing.Optional[list[BlockUid]]) -> None: ...",
    "def f(uids: Annotated[list[BlockUid], 'doc']) -> None: ...",
    "def f(uid: Annotated[BlockUid, 'doc']) -> None: ...",
    "def f(uid: dict[BlockUid, str]) -> None: ...",
    "def f(uid: Mapping[BlockUid, list[str]]) -> None: ...",
    "def f(uid: Union[BlockUid, None]) -> None: ...",
    "def f(uid: 'list[BlockUid | None]') -> None: ...",
    "def f(uid: BlockUid = None) -> None: ...",
    "def f(uid: 'BlockUid') -> None: ...",
    "def f(uid: 'BlockUid | None') -> None: ...",
    "def f(uid: ops.BlockUid) -> None: ...",
    "def f(title: str) -> None: ...",
    "def f(order_idx: SidebarOrderIdx) -> None: ...",
    "def f(order_idx: OrderIdx) -> None: ...",
])
def test_a_branded_or_unrelated_parameter_is_clean(source: str):
    assert rules(source + "\n") == []


@pytest.mark.parametrize("source", [
    "class A(TypedDict):\n    page_id: int\n",
    "@dataclass\nclass A:\n    page_id: int\n",
    "class A(BaseModel):\n    page_id: int | None = None\n",
])
def test_a_class_field_is_checked(source: str):
    assert rules(source) == ["brand-name"]


def test_keyword_only_star_and_double_star_parameters_are_checked():
    source = "def f(a, *, uid: str, **page_id: int) -> None: ...\ndef g(*uids: str) -> None: ...\n"
    assert rules(source) == ["brand-name"] * 3


def test_async_functions_and_methods_are_checked():
    assert rules("class A:\n    async def f(self, seq: int) -> None: ...\n") == ["brand-name"]


def test_the_violation_names_the_site_and_the_brand():
    [v] = check_text(PRODUCT, "x = 1\ndef f(uid: str) -> None: ...\n", REGISTRY)
    assert v == Violation(PRODUCT, 2, "brand-name", "`uid` must be BlockUid: def f(uid: str) -> None: ...")


def test_a_plain_int_for_a_two_brand_name_is_a_violation():
    assert rules("def f(order_idx: int) -> None: ...\n") == ["brand-name"]


def test_either_brand_of_a_two_brand_name_satisfies_it():
    for brand in ("OrderIdx", "SidebarOrderIdx"):
        assert rules(f"def f(order_idx: {brand}) -> None: ...\n") == []


OPT_OUT = "def f(uids: str) -> None: ...  # brand: untrusted -- comma-separated query param\n"


def test_the_opt_out_is_allowed_in_a_route_module():
    assert rules(OPT_OUT, ROUTES) == []


def test_the_opt_out_on_a_wrapped_parameter_covers_its_lines():
    source = "def f(\n    uids: str,  # brand: untrusted -- comma-separated query param\n) -> None: ...\n"
    assert rules(source, ROUTES) == []


def test_the_opt_out_outside_a_route_module_is_itself_a_violation():
    assert sorted(rules(OPT_OUT, OPS_CORE)) == ["brand-name", "brand-opt-out"]


def test_a_marker_quoted_in_a_string_or_prose_comment_is_not_an_opt_out():
    source = 'DOC = "# brand: untrusted"\n# write `# brand: untrusted -- why` on the line\n'
    assert rules(source, OPS_CORE) == []


def test_the_opt_out_without_a_reason_is_a_violation():
    source = "def f(uids: str) -> None: ...  # brand: untrusted\n"
    assert "brand-opt-out" in rules(source, ROUTES)
    assert "brand-opt-out" in rules("def f(uids: str) -> None: ...  # brand: untrusted --\n", ROUTES)


@pytest.mark.parametrize("path", ["web/src/x.ts", "server/src/pkm/x.txt", "docs/x.py"])
def test_files_outside_server_python_are_not_checked(path: str):
    assert rules("def f(uid: str) -> None: ...\n", path) == []


@pytest.mark.parametrize("path", ["server/tests/test_x.py", "server/src/pkm/test_data/core.py"])
def test_tests_and_test_data_are_checked(path: str):
    assert rules("def f(uid: str) -> None: ...\n", path) == ["brand-name"]


def test_a_brand_name_in_a_test_names_the_helper():
    [v] = check_text("server/tests/test_x.py", "def f(page_id: int) -> None: ...\n", REGISTRY)
    assert "page_id_of" in v.text


@pytest.mark.parametrize("source", [
    "def make(uid): ...",
    "def make(a, *, page_id): ...",
    "def make(*uids): ...",
    "async def make(seq=None): ...",
])
def test_an_unannotated_brand_name_parameter_is_flagged(source: str):
    assert rules(source + "\n") == ["brand-name"]


def test_the_unannotated_message_says_to_annotate_it():
    [v] = check_text(PRODUCT, "def make(uid): ...\n", REGISTRY)
    assert "annotate it `BlockUid`" in v.text


def test_a_lambda_parameter_is_not_checked():
    assert rules("f = lambda uid: uid\n") == []


def test_every_rule_has_a_remedy_that_names_the_fix():
    assert set(RULES) == {"brand-name", "brand-opt-out", "brand-parse", "brand-mint",
                          "brand-cast", "model-construct", "raw-sqlite",
                          "test-mint-import", "brand-ignore", "brand-launder",
                          "brand-file-ignore", "brand-opt-out-unused"}
    assert "select()" in RULES["brand-name"] and "untrusted" in RULES["brand-name"]


@pytest.mark.parametrize("annotation", [
    "BlockUid | str",
    "Union[str, BlockUid]",
    "Optional[str]",
    "BlockUid | Any",
    "BlockUid | object",
    "Annotated[str, Field(description='BlockUid')]",
    "Literal['BlockUid']",
    "list[BlockUid | str]",
])
def test_an_annotation_that_allows_the_plain_type_is_flagged(annotation: str):
    assert rules(f"def f(uid: {annotation}) -> None: ...\n") == ["brand-name"]


@pytest.mark.parametrize("annotation", [
    "Annotated[BlockUid, Field(min_length=1)]",
    "BlockUid | None",
    "list[BlockUid] | None",
    "'BlockUid | None'",
    "Optional[BlockUid]",
    "Union[BlockUid, None]",
])
def test_an_annotation_that_carries_the_brand_is_clean(annotation: str):
    assert rules(f"def f(uid: {annotation}) -> None: ...\n") == []


def test_an_int_brand_rejects_int_in_a_union():
    assert rules("def f(page_id: PageId | int) -> None: ...\n") == ["brand-name"]


def test_unparseable_source_is_a_loud_violation_naming_the_interpreter():
    [v] = check_text(PRODUCT, "def f(:\n", REGISTRY)
    assert v.rule == "brand-parse"
    assert "does not parse under Python 3." in v.text
    assert "needs >= 3.12 for PEP 695 syntax" in v.text
    assert "invalid syntax" in v.text
    assert "brand-parse" in RULES


@pytest.mark.parametrize("source", [
    "def f(uid: dict[str, BlockUid]) -> None: ...",
    "def f(uid: Mapping[str, BlockUid]) -> None: ...",
    "def f(uid: Callable[[BlockUid], int]) -> None: ...",
    "def f(uid: Awaitable[BlockUid]) -> None: ...",
    "def f(uid: Literal['a'] | BlockUid) -> None: ...",
    "def f(uid: BlockUid | Other) -> None: ...",
    "def f(uids: list[str | BlockUid]) -> None: ...",
    "def f(uids: list[dict[str, BlockUid]]) -> None: ...",
    "def f(uid: Box[BlockUid]) -> None: ...",
    "def f(uid: type[BlockUid]) -> None: ...",
])
def test_a_generic_that_merely_mentions_the_brand_is_flagged(source: str):
    assert rules(source + "\n") == ["brand-name"]


@pytest.mark.parametrize("source", [
    "class A:\n    def __init__(self, x: int) -> None:\n        self.uid: str = x\n",
    "class A:\n    def m(self) -> None:\n        self.page_id: int | None = None\n",
    "class A:\n    if TYPE_CHECKING:\n        uid: str\n",
    "class A:\n    try:\n        seq: int = 0\n    except Exception:\n        pass\n",
    "class A:\n    with ctx():\n        page_id: int\n",
    "A = TypedDict('A', {'uid': str})",
    "A = TypedDict('A', uid=str)",
    "A = typing.TypedDict('A', {'page_id': int}, total=False)",
    "A = NamedTuple('A', [('seq', int)])",
    "A = typing.NamedTuple('A', [('uid', str), ('title', str)])",
    "A = NamedTuple('A', uid=str)",
])
def test_attributes_conditional_fields_and_functional_forms_are_checked(source: str):
    assert rules(source) == ["brand-name"]


@pytest.mark.parametrize("source", [
    "class A:\n    def __init__(self, x: BlockUid) -> None:\n        self.uid: BlockUid = x\n",
    "class A:\n    def m(self, x: int) -> None:\n        self.uid = x\n",
    "class A:\n    if TYPE_CHECKING:\n        uid: BlockUid\n",
    "A = TypedDict('A', {'uid': BlockUid, 'title': str})",
    "A = NamedTuple('A', [('seq', SyncSeq), ('title', str)])",
    "A = TypedDict('A', {})",
    "A = NamedTuple('A', fields)",
    "A = TypedDict('A', {**base, 'uid': BlockUid})",
])
def test_branded_or_unannotated_attributes_and_functional_forms_are_clean(source: str):
    assert rules(source + "\n") == []


def test_a_nested_function_in_a_class_conditional_is_not_a_class_field():
    source = "class A:\n    if X:\n        def m(self) -> None:\n            uid: str = ''\n"
    assert rules(source) == []


def test_an_opt_out_covers_one_site_not_every_site_on_its_line():
    source = ("def f(uids: str, page_ids: str) -> None: ...  # brand: untrusted -- comma-separated query\n")
    assert rules(source, ROUTES) == ["brand-name"]


def test_an_opt_out_covers_the_leftmost_site_on_its_line():
    source = "def f(uids: str, page_ids: str) -> None: ...  # brand: untrusted -- comma-separated query\n"
    [v] = check_text(ROUTES, source, REGISTRY)
    assert "`page_ids`" in v.text


def test_each_wrapped_site_takes_its_own_opt_out():
    source = ("def f(\n    uids: str,  # brand: untrusted -- comma-separated query\n"
              "    page_ids: str,  # brand: untrusted -- comma-separated query\n) -> None: ...\n")
    assert rules(source, ROUTES) == []


def test_an_opt_out_that_covers_nothing_is_reported():
    source = "def f(uids: list[BlockUid]) -> None: ...  # brand: untrusted -- comma-separated query\n"
    assert rules(source, ROUTES) == ["brand-opt-out-unused"]


def test_an_opt_out_on_an_unrelated_line_is_reported_and_the_site_is_not_covered():
    source = "x = 1  # brand: untrusted -- query\ndef f(uids: str) -> None: ...\n"
    assert sorted(rules(source, ROUTES)) == ["brand-name", "brand-opt-out-unused"]


def test_a_used_opt_out_is_not_reported():
    assert rules(OPT_OUT, ROUTES) == []


def test_the_stale_opt_out_names_its_line():
    source = "x = 1\ny = 2  # brand: untrusted -- query\n"
    [v] = check_text(ROUTES, source, REGISTRY)
    assert (v.line, v.rule) == (2, "brand-opt-out-unused")


@pytest.mark.parametrize("source, expected", [
    ("def f(page_title: str) -> None: ...", ["brand-name"]),
    ("def f(page_title: RawTitle | None) -> None: ...", []),
    ("def f(page_title: CanonicalTitle) -> None: ...", []),
    ("def f(ref_title: CanonicalTitle) -> None: ...", ["brand-name"]),
    ("def f(ref_title: NormalizedTitle) -> None: ...", []),
    ("def f(canonical_title: CanonicalTitle) -> None: ...", []),
    ("def f(raw_title: str) -> None: ...", ["brand-name"]),
])
def test_title_names_take_their_brands(source: str, expected: list[str]):
    assert rules(source + "\n") == expected
