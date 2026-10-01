"""brand() tags a NewType so its JSON schema carries an x-brand marker,
which gen-types turns into a web brand, and leaves validation and
serialisation exactly as the unbranded type's."""
from __future__ import annotations

from pathlib import Path
from typing import NewType

import pytest
from pydantic import BaseModel, Field, ValidationError

from pkm.contracts.brands import brand
from pkm.server.app import create_app
from pkm.server.config import Config

Tagged = NewType("Tagged", str)
brand(Tagged)
TaggedInt = NewType("TaggedInt", int)
brand(TaggedInt)
Plain = NewType("Plain", str)
Parent = NewType("Parent", str)
brand(Parent)
Child = NewType("Child", Parent)
brand(Child)


class M(BaseModel):
    h: Tagged | None = Field(default=None, min_length=4, max_length=4)
    xs: list[Tagged] = []
    n: TaggedInt


class Unbranded(BaseModel):
    p: Plain


class Nested(BaseModel):
    parent: Parent
    child: Child


def test_schema_carries_brand_beside_constraints():
    props = M.model_json_schema()["properties"]
    assert props["h"]["anyOf"][0] == {"type": "string", "minLength": 4,
                                      "maxLength": 4, "x-brand": "Tagged"}
    assert props["h"]["anyOf"][1] == {"type": "null"}
    assert props["xs"]["items"]["x-brand"] == "Tagged"
    assert props["n"] == {"title": "N", "type": "integer",
                          "x-brand": "TaggedInt"}


def test_validation_unchanged():
    with pytest.raises(ValidationError) as short:
        M(h=Tagged("abc"), n=TaggedInt(1))
    assert short.value.errors()[0]["type"] == "string_too_short"
    with pytest.raises(ValidationError) as not_int:
        M.model_validate({"n": "x"})
    assert not_int.value.errors()[0]["type"] == "int_parsing"
    m = M.model_validate({"h": "abcd", "xs": ["q"], "n": "2"})
    assert m.model_dump() == {"h": "abcd", "xs": ["q"], "n": 2}


def test_unbranded_newtype_has_no_marker():
    assert "x-brand" not in Unbranded.model_json_schema()["properties"]["p"]


def test_branded_subtype_carries_its_own_name():
    props = Nested.model_json_schema()["properties"]
    assert props["parent"] == {"title": "Parent", "type": "string",
                               "x-brand": "Parent"}
    assert props["child"] == {"title": "Child", "type": "string",
                              "x-brand": "Child"}
    with pytest.raises(ValidationError) as not_str:
        Nested.model_validate({"parent": 1, "child": 2})
    assert [e["type"] for e in not_str.value.errors()] == ["string_type"] * 2
    n = Nested.model_validate({"parent": "a", "child": "b"})
    assert n.model_dump() == {"parent": "a", "child": "b"}


def test_openapi_marks_op_hashes(tmp_path: Path):
    config = Config(db_path=tmp_path / "pkm.sqlite3",
                    assets_dir=tmp_path / "assets",
                    password_salt="00" * 16, password_hash="ab" * 32,
                    session_secret="cd" * 32, cookie_secure=False)
    schemas = create_app(config).openapi()["components"]["schemas"]
    # FastAPI may split a model into -Input and -Output components; every
    # copy must carry the brand.
    hashed = {"UpdateTextOp": "base_text_hash", "DeleteOp": "base_subtree_hash"}
    for prefix, field in hashed.items():
        names = [n for n in schemas if n.startswith(prefix)]
        assert names, prefix
        for name in names:
            branch = schemas[name]["properties"][field]["anyOf"][0]
            assert branch["x-brand"] == "Sha256Hex", name
            assert branch["minLength"] == branch["maxLength"] == 64, name
