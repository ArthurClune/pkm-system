# pattern: Functional Core
"""Pure validation models and parser for committed synthetic graph sources."""
from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Set
from typing import Literal, cast

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    ValidationError,
    field_validator,
)

ASSET_PLACEHOLDER_RE = re.compile(r"\{\{asset:([^{}]+)\}\}")


class SourceValidationError(ValueError):
    """Raised when the committed graph source violates its schema or invariants."""


class BlockSource(BaseModel):
    """One strictly typed block in the human-readable source graph."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    uid: StrictStr = Field(min_length=1)
    parent_uid: StrictStr | None
    order_idx: StrictInt = Field(ge=0)
    text: StrictStr
    heading: Literal[1, 2, 3] | None

    @field_validator("heading", mode="before")
    @classmethod
    def _validate_heading(cls, value: object) -> object:
        if value is None or type(value) is int:
            return value
        raise ValueError("heading must be an exact integer")

    collapsed: StrictBool
    view_type: Literal["numbered", "document"] | None
    created_at: StrictInt | None
    updated_at: StrictInt | None


class PageSource(BaseModel):
    """One page and its flat, relationship-validated source blocks."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    title: StrictStr = Field(min_length=1)
    created_at: StrictInt | None
    updated_at: StrictInt | None
    blocks: tuple[BlockSource, ...]


class GraphSource(BaseModel):
    """Validated source graph and ordered sidebar titles."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    pages: tuple[PageSource, ...]
    sidebar_entries: tuple[StrictStr, ...]


def parse_graph_source(raw: object, *, asset_names: Set[str]) -> GraphSource:
    """Validate a raw graph source payload and return its immutable model."""
    try:
        source = GraphSource.model_validate(raw)
    except ValidationError as exc:
        raise SourceValidationError(_format_validation_error(exc)) from None

    _validate_unique_page_titles(source)
    block_by_uid, block_owner = _index_blocks(source)
    _validate_parent_relationships(source, block_owner)
    _validate_parent_cycles(source, block_by_uid)
    _validate_sibling_order(source)
    _validate_sidebar_entries(source)
    _validate_asset_placeholders(source, asset_names)
    return source


def _format_validation_error(exc: ValidationError) -> str:
    messages: list[str] = []
    for error in exc.errors():
        loc = cast(tuple[object, ...], error.get("loc", ()))
        path = ".".join(str(part) for part in loc)
        msg = str(error["msg"])
        messages.append(f"{path}: {msg}" if path else msg)
    return "; ".join(messages)


def _validate_unique_page_titles(source: GraphSource) -> None:
    seen: set[str] = set()
    for page in source.pages:
        if page.title in seen:
            raise SourceValidationError(f"duplicate page title: {page.title}")
        seen.add(page.title)


def _index_blocks(source: GraphSource) -> tuple[dict[str, BlockSource], dict[str, str]]:
    block_by_uid: dict[str, BlockSource] = {}
    block_owner: dict[str, str] = {}
    for page in source.pages:
        for block in page.blocks:
            if block.uid in block_by_uid:
                raise SourceValidationError(f"duplicate block uid: {block.uid}")
            block_by_uid[block.uid] = block
            block_owner[block.uid] = page.title
    return block_by_uid, block_owner


def _validate_parent_relationships(source: GraphSource, block_owner: dict[str, str]) -> None:
    for page in source.pages:
        for block in page.blocks:
            parent_uid = block.parent_uid
            if parent_uid is None:
                continue
            parent_owner = block_owner.get(parent_uid)
            if parent_owner is None:
                raise SourceValidationError(f"{block.uid}: unknown parent uid: {parent_uid}")
            if parent_owner != page.title:
                raise SourceValidationError(
                    f"{block.uid}: parent uid belongs to another page: {parent_uid}",
                )


def _validate_parent_cycles(source: GraphSource, block_by_uid: dict[str, BlockSource]) -> None:
    for page in source.pages:
        for block in page.blocks:
            path: list[str] = []
            index_by_uid: dict[str, int] = {}
            current = block
            while True:
                current_uid = current.uid
                if current_uid in index_by_uid:
                    start = index_by_uid[current_uid]
                    cycle = path[start:] + [current_uid]
                    raise SourceValidationError(f"parent cycle: {' -> '.join(cycle)}")
                index_by_uid[current_uid] = len(path)
                path.append(current_uid)
                parent_uid = current.parent_uid
                if parent_uid is None:
                    break
                current = block_by_uid[parent_uid]


def _validate_sibling_order(source: GraphSource) -> None:
    for page in source.pages:
        groups: dict[str | None, list[BlockSource]] = defaultdict(list)
        for block in page.blocks:
            groups[block.parent_uid].append(block)
        for parent_uid, group in groups.items():
            sorted_order_indexes = sorted(block.order_idx for block in group)
            expected = list(range(len(group)))
            if sorted_order_indexes != expected:
                label = page.title if parent_uid is None else parent_uid
                raise SourceValidationError(
                    f"non-contiguous order_idx under {label}: expected {expected}, got {sorted_order_indexes}",
                )


def _validate_sidebar_entries(source: GraphSource) -> None:
    seen: set[str] = set()
    page_titles = {page.title for page in source.pages}
    for title in source.sidebar_entries:
        if title in seen:
            raise SourceValidationError(f"duplicate sidebar title: {title}")
        seen.add(title)
        if title not in page_titles:
            raise SourceValidationError(f"sidebar title is not an explicit page: {title}")


def _validate_asset_placeholders(source: GraphSource, asset_names: Set[str]) -> None:
    for page in source.pages:
        for block in page.blocks:
            for match in ASSET_PLACEHOLDER_RE.finditer(block.text):
                asset_name = match.group(1)
                if asset_name not in asset_names:
                    raise SourceValidationError(f"unknown asset placeholder: {asset_name}")
