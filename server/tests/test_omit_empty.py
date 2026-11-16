"""A response field the serializer leaves out when empty must be optional
in the generated TypeScript. openapi-typescript types a property that
carries a schema `default` as required, so such a field is declared with a
`default_factory`, whose schema carries none."""
from __future__ import annotations

import pytest
from pydantic import Field, SerializerFunctionWrapHandler, model_serializer
from pydantic_core import PydanticSerializationError

from pkm.contracts.responses import RecordCell, _omit_empty
from pkm.contracts.strict import StrictModel


class _Plain(StrictModel):
    n: int = 0

    @model_serializer(mode="wrap")
    def _serialize(self, handler: SerializerFunctionWrapHandler):  # noqa: ANN202
        return _omit_empty(self, handler, "n")


class _Factory(StrictModel):
    n: int = Field(default_factory=int)

    @model_serializer(mode="wrap")
    def _serialize(self, handler: SerializerFunctionWrapHandler):  # noqa: ANN202
        return _omit_empty(self, handler, "n")


def test_an_omitted_field_with_a_plain_default_is_refused():
    with pytest.raises(PydanticSerializationError, match="default_factory"):
        _Plain().model_dump()


def test_an_omitted_field_with_a_factory_is_left_out_when_empty():
    assert _Factory().model_dump() == {}
    assert _Factory(n=2).model_dump() == {"n": 2}


def test_record_cell_child_count_carries_no_schema_default():
    cell = RecordCell.model_json_schema(mode="serialization")
    assert "default" not in cell["properties"]["child_count"]
    assert "child_count" not in cell["required"]
