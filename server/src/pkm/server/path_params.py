# pattern: Functional Core
"""Route dependencies that parse a branded path segment, so a handler only
ever receives the checked brand.

Each takes the segment as an aliased `str` rather than as the brand: the
`x-brand` marker in `Path(...)` keeps the OpenAPI parameter (and so the
generated web path type) exactly what a brand-typed parameter gives, while
the parse, not FastAPI, decides the status a malformed segment answers.
Declare the dependency before `get_db` or `get_goodlinks`, so a malformed
segment answers before a connection opens or the gateway is looked up."""
from __future__ import annotations

from typing import Annotated

from fastapi import HTTPException, params

from pkm.assets_core import parse_sha256
from pkm.contracts.ops import BlockUid, Sha256Hex
from pkm.goodlinks import GoodlinksId, parse_link_id
from pkm.refs import parse_block_uid


def _segment(name: str, brand: object) -> params.Path:
    return params.Path(
        alias=name, json_schema_extra={"x-brand": getattr(brand, "__name__")})


def path_uid(segment: Annotated[str, _segment("uid", BlockUid)]) -> BlockUid:
    uid = parse_block_uid(segment)
    if uid is None:
        raise HTTPException(status_code=422,
                            detail=f"malformed uid: {segment!r}")
    return uid


def path_sha256(
        segment: Annotated[str, _segment("sha256", Sha256Hex)]) -> Sha256Hex:
    sha = parse_sha256(segment)
    if sha is None:
        raise HTTPException(status_code=404, detail="asset not found")
    return sha


def path_link_id(
        segment: Annotated[str, _segment("link_id", GoodlinksId)]
) -> GoodlinksId:
    link_id = parse_link_id(segment)
    if link_id is None:
        raise HTTPException(status_code=404, detail="not found")
    return link_id
