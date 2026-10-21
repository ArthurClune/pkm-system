"""The 422 body: FastAPI's own rendering of pydantic's errors wherever
that encodes, and JSON that always encodes where it would not."""
import json
import math

from fastapi.encoders import jsonable_encoder
from pydantic import ValidationError

from pkm.contracts.strict import StrictModel
from pkm.server.validation_echo import MAX_ECHO_DEPTH, TOO_DEEP, echo_errors


class _Body(StrictModel):
    label: str
    count: int


def _errors(data: object) -> list:
    try:
        _Body.model_validate(data)
    except ValidationError as exc:
        return exc.errors()
    raise AssertionError("expected a validation error")


def test_an_ordinary_echo_is_what_fastapi_renders():
    errors = _errors({"label": 3, "count": "x", "extra": [1, None, True]})
    assert echo_errors(errors) == jsonable_encoder(errors)


def test_an_exception_in_ctx_renders_as_fastapi_renders_it():
    errors = [{"type": "value_error", "loc": ("body",), "msg": "bad",
               "input": "x", "ctx": {"error": ValueError("bad")}}]
    assert echo_errors(errors) == jsonable_encoder(errors)


def test_what_fastapi_cannot_encode_renders_as_its_str():
    class Opaque:
        __slots__ = ()

        def __str__(self) -> str:
            return "opaque\ud800"

    (error,) = echo_errors([{"ctx": {"error": Opaque()}}])
    assert error == {"ctx": {"error": "opaque�"}}


def test_hostile_input_echoes_as_json_that_encodes():
    deep: list[object] = ["bottom"]
    for _ in range(MAX_ECHO_DEPTH * 2):
        deep = [deep]
    errors = _errors({"label": [math.nan, math.inf, -math.inf, "x\udc00",
                                {"k\ud800": deep}], "count": 1})
    echoed = echo_errors(errors)
    json.dumps(echoed, allow_nan=False).encode()
    (error,) = echoed
    assert isinstance(error, dict) and isinstance(error["input"], list)
    nan, inf, ninf, text, nested = error["input"]
    assert (nan, inf, ninf, text) == ("NaN", "Infinity", "-Infinity", "x�")
    assert TOO_DEEP in json.dumps(nested["k�"], ensure_ascii=False)
