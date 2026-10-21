# pattern: Functional Core
"""The body of a 422: pydantic's validation errors, each echoing the input
it refused, made into JSON that always encodes.

FastAPI's own handler hands the echo to a strict JSON encoder, so a 422
on hostile input became a 500: a lone surrogate fails to encode as UTF-8,
NaN and Infinity (Python's json reads both) are refused by
`allow_nan=False`, and input nested past the recursion limit overflows
`jsonable_encoder`. Here a str is made well-formed, a non-finite number
becomes the literal it was sent as, and a container deeper than
`MAX_ECHO_DEPTH` is cut to a marker. For any other input the result is
what FastAPI's handler renders."""
from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

from fastapi.encoders import jsonable_encoder

from pkm.contracts.text import well_formed

# An echo is for reading, and nothing a route accepts nests this deep.
MAX_ECHO_DEPTH = 32
TOO_DEEP = "…"

_NON_FINITE = {math.inf: "Infinity", -math.inf: "-Infinity"}


def _echo(value: object, depth: int) -> object:
    if isinstance(value, str):
        return well_formed(value)
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        return _NON_FINITE.get(value, value)
    if depth >= MAX_ECHO_DEPTH:
        return TOO_DEEP
    if isinstance(value, Mapping):
        return {str(_echo(k, depth + 1)): _echo(v, depth + 1)
                for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_echo(item, depth + 1) for item in value]
    # An exception in `ctx`, say: FastAPI's encoder decides its shape.
    try:
        encoded = jsonable_encoder(value)
    except (ValueError, TypeError):
        return well_formed(str(value))
    return _echo(encoded, depth + 1)


def echo_errors(errors: Sequence[object]) -> list[object]:
    """`errors` (a RequestValidationError's) as JSON-encodable values."""
    return [_echo(error, 0) for error in errors]
