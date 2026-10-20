# pattern: Functional Core
"""The tests' one mint module: a checked helper per brand, `<stem>_of`,
named from brand_registry.TEST_HELPERS. Each helper checks its value has
the brand's shape (brand_registry.SHAPES) or base type and raises
ValueError otherwise, so a fixture value is always one the product could
have produced. A short tag becomes a uid by prefixing `tuid-`
(`uid_of("tuid-a")`).

A negative test forges a bad value through `malformed_uid`,
`malformed_sha`, `malformed_seq` or `malformed_canonical_title`, which
return it unchecked (None where a test needs a missing value). Product code
may not import this module; the brand lint reports it."""
from __future__ import annotations

import re

from pkm.brand_registry import MALFORMED, SHAPES
from pkm.contracts.ops import (BatchId, BlockUid, ClientId, OrderIdx, PageId,
                               Sha256Hex, SidebarEntryId, SidebarOrderIdx,
                               SyncSeq)
from pkm.contracts.responses import ConfirmId, ConversationId
from pkm.goodlinks import GoodlinksId
from pkm.contracts.titles import (
    CanonicalTitle,
    NormalizedTitle,
    RawTitle,
    as_raw_title,
)


def _text(brand: str, value: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{brand} takes a str, not {type(value).__name__}: {value!r}")
    pattern = SHAPES[brand][1]
    if pattern is not None and not re.fullmatch(pattern, value):
        raise ValueError(f"{value!r} is not a valid {brand}; a negative test forges one with "
                         f"malformed_{MALFORMED[brand]}")
    return value


def _int(brand: str, value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{brand} takes an int, not {type(value).__name__}: {value!r}")
    return value


def uid_of(value: str) -> BlockUid:
    return BlockUid(_text("BlockUid", value))


def page_id_of(value: int) -> PageId:
    return PageId(_int("PageId", value))


def sidebar_entry_id_of(value: int) -> SidebarEntryId:
    return SidebarEntryId(_int("SidebarEntryId", value))


def order_idx_of(value: int) -> OrderIdx:
    return OrderIdx(_int("OrderIdx", value))


def sidebar_order_idx_of(value: int) -> SidebarOrderIdx:
    return SidebarOrderIdx(_int("SidebarOrderIdx", value))


def seq_of(value: int) -> SyncSeq:
    return SyncSeq(_int("SyncSeq", value))


def client_id_of(value: str) -> ClientId:
    return ClientId(_text("ClientId", value))


def batch_id_of(value: str) -> BatchId:
    return BatchId(_text("BatchId", value))


def sha_of(value: str) -> Sha256Hex:
    return Sha256Hex(_text("Sha256Hex", value))


def conversation_id_of(value: str) -> ConversationId:
    return ConversationId(_text("ConversationId", value))


def confirm_id_of(value: str) -> ConfirmId:
    return ConfirmId(_text("ConfirmId", value))


def goodlinks_id_of(value: str) -> GoodlinksId:
    return GoodlinksId(_text("GoodlinksId", value))


def raw_title_of(value: str) -> RawTitle:
    return as_raw_title(_text("RawTitle", value))


def normalized_title_of(value: str) -> NormalizedTitle:
    return NormalizedTitle(raw_title_of(value))


def canonical_title_of(value: str) -> CanonicalTitle:
    return CanonicalTitle(normalized_title_of(value))


def malformed_uid(value: str | None) -> BlockUid:
    return BlockUid(value)  # pyrefly: ignore[bad-argument-type]


def malformed_sha(value: str) -> Sha256Hex:
    return Sha256Hex(value)


def malformed_seq(value: int) -> SyncSeq:
    return SyncSeq(value)


def malformed_canonical_title(value: str | None) -> CanonicalTitle:
    return CanonicalTitle(value)  # pyrefly: ignore[bad-argument-type]
