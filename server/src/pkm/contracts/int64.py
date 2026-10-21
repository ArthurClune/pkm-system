# pattern: Functional Core
"""Integers a request may carry: SQLite stores an INTEGER in 64 bits, and
Python's sqlite3 raises OverflowError binding an int outside that range,
so an unbounded int from a request reached the database as a 500. Every
int path or query parameter is `Int64` (or carries `INT64_RANGE`), which
makes an out-of-range value the 422 of any other invalid parameter; a
test walks the app's routes to keep it so. A request body's ints are
checked by `contracts.text.WellFormedModel`, at any depth."""
from __future__ import annotations

from typing import Annotated

from annotated_types import Interval

INT64_MIN = -(2 ** 63)
INT64_MAX = 2 ** 63 - 1
INT64_RANGE = Interval(ge=INT64_MIN, le=INT64_MAX)

Int64 = Annotated[int, INT64_RANGE]
