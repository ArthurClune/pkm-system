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


def test_turning_strict_off_is_reported():
    assert rules('class M(StrictModel):\n    model_config = {"strict": False}\n') == ["model-strict"]
    assert rules("class M(StrictModel):\n    model_config = ConfigDict(strict=False)\n") == ["model-strict"]
    assert rules("x: int = Field(strict=False)\n") == ["model-strict"]
    assert rules("m = M.model_validate_json(t, strict=False)\n") == ["model-strict"]


def test_strict_true_is_clean():
    assert rules("x: int = Field(strict=True)\n") == []
    assert rules('c = {"strict": True}\n') == []


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


def test_validating_decoded_input_is_clean():
    assert rules("m = M.model_validate(json.loads(body))\n") == []
    assert rules("m = M.model_validate(row)\n") == []
    assert rules("m = M.model_validate_json(body)\n") == []


def test_model_copy_with_update_is_reported():
    assert rules("m = x.model_copy(update={'a': 1})\n") == ["model-unchecked"]


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
