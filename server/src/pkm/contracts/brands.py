# pattern: Functional Core
"""Carries a NewType's name into the JSON schema as an `x-brand` marker.

A NewType adds nothing to JSON Schema, so without a marker the web's
generated types see a branded field as a plain string. `brand(Name)`
makes pydantic validate and dump `Name` exactly as its supertype and
adds `"x-brand": "Name"` to the schema; `web/tooling/genTypes.mjs` turns
that marker into the hand-written `Brands.Name` of `web/src/api/brands.ts`.

Tag a NewType in its own statement after declaring it:

    Sha256Hex = NewType("Sha256Hex", str)
    brand(Sha256Hex)

Never wrap the `NewType(...)` call itself: pyrefly stops treating the
result as a type once the call sits inside another call."""
from __future__ import annotations

from typing import Any

from pydantic import GetCoreSchemaHandler, GetJsonSchemaHandler
from pydantic.json_schema import JsonSchemaValue
from pydantic_core import CoreSchema


def brand(nt: object) -> None:
    name: str = getattr(nt, "__name__")
    supertype: object = getattr(nt, "__supertype__")

    def core_schema(_source: Any, handler: GetCoreSchemaHandler) -> CoreSchema:
        return handler(supertype)

    def json_schema(schema: CoreSchema,
                    handler: GetJsonSchemaHandler) -> JsonSchemaValue:
        out = handler(schema)
        out["x-brand"] = name
        return out

    setattr(nt, "__get_pydantic_core_schema__", core_schema)
    setattr(nt, "__get_pydantic_json_schema__", json_schema)
