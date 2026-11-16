"""A response field the serializer leaves out when empty must be optional
in the generated TypeScript. openapi-typescript types a property that
carries a schema `default` as required, so such a field is declared with a
`default_factory`, whose schema carries none. `OmitEmptyModel` checks that
when the class is defined, so a wrong declaration fails at import."""
from __future__ import annotations

from typing import ClassVar

import pytest
from pydantic import Field

from pkm.contracts.responses import (OmitEmptyModel, QueryRecordsPayload,
                                     RecordCell)


def test_an_omitted_field_with_a_plain_default_is_refused_at_definition():
    with pytest.raises(TypeError, match="default_factory"):
        class _Plain(OmitEmptyModel):
            omit_when_empty: ClassVar[tuple[str, ...]] = ("n",)
            n: int = 0


def test_an_omitted_field_with_no_default_is_refused_at_definition():
    with pytest.raises(TypeError, match="default_factory"):
        class _Required(OmitEmptyModel):
            omit_when_empty: ClassVar[tuple[str, ...]] = ("n",)
            n: int


def test_an_omitted_name_that_is_not_a_field_is_refused_at_definition():
    with pytest.raises(TypeError, match="no field"):
        class _Typo(OmitEmptyModel):
            omit_when_empty: ClassVar[tuple[str, ...]] = ("m",)
            n: int = Field(default_factory=int)


def test_a_model_omitting_nothing_is_refused_at_definition():
    with pytest.raises(TypeError, match="omit_when_empty"):
        class _Nothing(OmitEmptyModel):
            n: int = Field(default_factory=int)


class _Factory(OmitEmptyModel):
    omit_when_empty: ClassVar[tuple[str, ...]] = ("n",)
    n: int = Field(default_factory=int)
    kept: list[int] = Field(default_factory=list)


def test_an_omitted_field_with_a_factory_is_left_out_when_empty():
    assert _Factory().model_dump() == {"kept": []}
    assert _Factory(n=2).model_dump() == {"n": 2, "kept": []}


def test_record_cell_child_count_carries_no_schema_default():
    cell = RecordCell.model_json_schema(mode="serialization")
    assert "default" not in cell["properties"]["child_count"]
    assert "child_count" not in cell["required"]


def test_records_payload_groups_is_required_and_nullable():
    schema = QueryRecordsPayload.model_json_schema(mode="serialization")
    assert "groups" in schema["required"]
    assert "default" not in schema["properties"]["groups"]
