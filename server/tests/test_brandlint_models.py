from pathlib import Path

import pytest

from brandlint.core import RULES, check_text
from brandlint.registry import load_registry

REPO = Path(__file__).resolve().parents[2]
REGISTRY = load_registry(REPO)
SRC = "server/src/pkm/store.py"
TEST = "server/tests/test_something.py"
TOOLING = "server/tooling/brandlint/core.py"
STRICT_FILE = "server/src/pkm/contracts/strict.py"


def rules(text: str, path: str = SRC) -> list[str]:
    return [v.rule for v in check_text(path, text, REGISTRY)]


def test_both_rules_are_documented():
    assert {"model-strict", "model-unchecked"} <= set(RULES)


def test_a_direct_basemodel_subclass_is_reported():
    assert rules("class M(BaseModel):\n    x: int\n") == ["model-strict"]
    assert rules("class M(pydantic.BaseModel):\n    x: int\n") == ["model-strict"]
    assert rules("class M(Other, BaseModel):\n    x: int\n") == ["model-strict"]


def test_the_strict_base_itself_is_allowed_only_in_its_file():
    text = "class StrictModel(BaseModel):\n    pass\n"
    assert rules(text, STRICT_FILE) == []
    assert rules(text, SRC) == ["model-strict"]
    assert rules("class Other(BaseModel):\n    pass\n", STRICT_FILE) == ["model-strict"]


def test_a_strict_model_subclass_is_clean():
    assert rules("class M(StrictModel):\n    x: int\n") == []


def test_an_aliased_basemodel_is_reported():
    assert rules("from pydantic import BaseModel as BM\nclass X(BM):\n    pass\n") == ["model-strict"]
    assert rules("import pydantic as pd\nclass X(pd.BaseModel):\n    pass\n") == ["model-strict"]
    assert rules("from pydantic import BaseModel as BM\nclass X(StrictModel):\n    pass\n") == []


def test_basemodel_imported_from_pydantic_main_is_resolved():
    text = "from pydantic.main import BaseModel as BM\nclass X(BM):\n    pass\n"
    assert rules(text) == ["model-strict"]
    assert rules("from pydantic.main import BaseModel\nclass X(BaseModel):\n    pass\n") == ["model-strict"]
    text = "from pydantic.root_model import RootModel as RM\nclass X(RM[int]):\n    pass\n"
    assert rules(text) == ["model-strict"]


def test_a_rootmodel_subclass_is_reported_under_any_spelling():
    assert rules("class X(RootModel):\n    root: int\n") == ["model-strict"]
    assert rules("class X(RootModel[int]):\n    pass\n") == ["model-strict"]
    assert rules("class X(pydantic.RootModel[int]):\n    pass\n") == ["model-strict"]
    assert rules("from pydantic import RootModel as RM\nclass X(RM[int]):\n    pass\n") == ["model-strict"]
    assert rules("import pydantic as pd\nclass X(pd.RootModel):\n    pass\n") == ["model-strict"]


@pytest.mark.parametrize("value", ["None", "flag", "False", "0"])
def test_strict_other_than_true_is_reported(value: str):
    assert rules(f"c = ConfigDict(strict={value})\n") == ["model-strict"]
    assert rules(f"x: int = Field(strict={value})\n") == ["model-strict"]
    assert rules(f'c = {{"strict": {value}}}\n') == ["model-strict"]


def test_turning_strict_off_is_reported():
    assert rules('class M(StrictModel):\n    model_config = {"strict": False}\n') == ["model-strict"]
    assert rules("class M(StrictModel):\n    model_config = ConfigDict(strict=False)\n") == ["model-strict"]
    assert rules("x: int = Field(strict=False)\n") == ["model-strict"]
    assert rules("m = M.model_validate_json(t, strict=False)\n") == ["model-strict"]


@pytest.mark.parametrize("value", ["False", "None", "flag", "0"])
def test_a_class_keyword_turning_strict_off_is_reported(value: str):
    assert rules(f"class M(StrictModel, strict={value}):\n    x: int\n") == ["model-strict"]


def test_strict_true_is_clean():
    assert rules("class M(StrictModel, strict=True):\n    x: int\n") == []
    assert rules("class M(StrictModel, frozen=True):\n    x: int\n") == []
    assert rules("x: int = Field(strict=True)\n") == []
    assert rules('c = {"strict": True}\n') == []


@pytest.mark.parametrize("call", ["Strict(False)", "Strict(strict=False)", "Strict(flag)", "pydantic.Strict(False)"])
def test_a_strict_marker_other_than_true_is_reported(call: str):
    assert rules(f"n: Annotated[int, {call}]\n") == ["model-strict"]


def test_a_strict_marker_of_true_is_clean():
    assert rules("n: Annotated[int, Strict(True)]\n") == []
    assert rules("n: Annotated[int, Strict()]\n") == []
    assert rules("n: Annotated[int, Strict(strict=True)]\n") == []


def test_create_model_is_reported():
    assert rules("M = create_model('M', x=(int, 1))\n") == ["model-strict"]
    assert rules("M = pydantic.create_model('M')\n") == ["model-strict"]


def test_pydantic_dataclasses_are_reported():
    assert rules("from pydantic.dataclasses import dataclass\n") == ["model-strict"]
    assert rules("import pydantic.dataclasses\n") == ["model-strict"]
    assert rules("from pydantic import dataclasses\n") == ["model-strict"]
    assert rules("d = pydantic.dataclasses.dataclass\n") == ["model-strict"]


def test_validate_call_is_reported():
    assert rules("@validate_call\ndef f(x: int) -> int:\n    return x\n") == ["model-strict"]
    assert rules("@pydantic.validate_call\ndef f(x: int) -> int:\n    return x\n") == ["model-strict"]


def test_validating_a_dict_built_in_place_is_reported():
    assert rules("m = M.model_validate({'a': 1})\n") == ["model-unchecked"]
    assert rules("m = M.model_validate(dict(a=1))\n") == ["model-unchecked"]
    assert rules("m = M.model_validate({k: v for k, v in xs})\n") == ["model-unchecked"]


@pytest.mark.parametrize("call", [
    "M.model_validate(obj={'a': 1})",
    "M.model_validate_strings({'a': '1'})",
    "M.model_validate_strings(dict(a='1'))",
    "TypeAdapter(M).validate_python({'a': 1})",
    "adapter.validate_python(object={'a': 1})",
    "M.model_validate_json(json.dumps({'a': 1}))",
    "M.model_validate_json(dumps({'a': 1}))",
    "adapter.validate_json(data=json.dumps(x))",
    "adapter.validate_strings({'a': '1'})",
    "adapter.validate_strings(dict(a='1'))",
    "adapter.validate_json(json.dumps(x))",
])
def test_every_spelling_of_a_dict_built_in_place_is_reported(call: str):
    assert rules(f"m = {call}\n") == ["model-unchecked"]


def test_an_aliased_dumps_is_reported():
    text = "from json import dumps as d\nm = M.model_validate_json(d(x))\n"
    assert rules(text) == ["model-unchecked"]


def test_decoding_a_literal_or_a_variable_is_clean():
    assert rules("m = M.model_validate_json('{\"a\": 1}')\n") == []
    assert rules("m = M.model_validate_json(text)\n") == []
    assert rules("m = M.model_validate_json(resp.text)\n") == []
    assert rules("m = M.model_validate(BATCH)\n") == []
    assert rules("m = adapter.validate_python(row)\n") == []
    assert rules("m = adapter.validate_json(raw)\n") == []


def test_validating_decoded_input_is_clean():
    assert rules("m = M.model_validate(json.loads(body))\n") == []
    assert rules("m = M.model_validate(row)\n") == []
    assert rules("m = M.model_validate_json(body)\n") == []


def test_model_copy_with_update_is_reported():
    assert rules("m = x.model_copy(update={'a': 1})\n") == ["model-unchecked"]


def test_the_v1_copy_with_update_is_reported():
    assert rules("m = x.copy(update={'a': 1})\n") == ["model-unchecked"]
    assert rules("m = x.copy(update=changes, deep=True)\n") == ["model-unchecked"]


@pytest.mark.parametrize("call", ["M.parse_obj({'a': 1})", "M.parse_obj(dict(a=1))", "M.parse_obj(obj={'a': 1})"])
def test_the_v1_parse_obj_of_a_dict_built_in_place_is_reported(call: str):
    assert rules(f"m = {call}\n") == ["model-unchecked"]


def test_v1_spellings_on_decoded_input_or_plain_dicts_are_clean():
    assert rules("m = M.parse_obj(row)\n") == []
    assert rules("d = row.copy()\n") == []
    assert rules("d = row.copy(deep=True)\n") == []
    assert rules("d = row.copy({'a': 1})\n") == []


def test_model_construct_by_either_spelling_is_reported():
    assert rules("m = M.construct(a=1)\n") == ["model-construct"]
    assert rules("m = M.model_construct(a=1)\n") == ["model-construct"]


def test_a_basemodel_imported_through_pydantic_main_module_is_resolved():
    text = "import pydantic.main as pm\nclass X(pm.BaseModel):\n    pass\n"
    assert rules(text) == ["model-strict"]
    text = "import pydantic.root_model as rm\nclass X(rm.RootModel[int]):\n    pass\n"
    assert rules(text) == ["model-strict"]


def test_model_copy_without_update_is_clean():
    assert rules("m = x.model_copy()\n") == []
    assert rules("m = x.model_copy(deep=True)\n") == []


@pytest.mark.parametrize("path", [TEST, TOOLING])
def test_each_rule_fires_in_tests_and_tooling(path: str):
    assert rules("class M(BaseModel):\n    x: int\n", path) == ["model-strict"]
    assert rules("m = M.model_validate({'a': 1})\n", path) == ["model-unchecked"]
    assert rules("m = x.model_copy(update={'a': 1})\n", path) == ["model-unchecked"]


def test_model_construct_now_suggests_keyword_constructors():
    assert "model_validate" not in RULES["model-construct"]
    assert "keyword" in RULES["model-construct"]
