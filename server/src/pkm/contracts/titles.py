# pattern: Functional Core
"""The title brands: a three-level hierarchy, each level its own brand.

    RawTitle        any title text, as typed or received; nothing checked
    NormalizedTitle a RawTitle through normalize_title
    CanonicalTitle  a NormalizedTitle through canonicalize_title, the exact
                    spelling pages.title and sidebar_entries.title hold

A level passes wherever a less-refined one is expected, never the reverse.
`as_raw_title` is the general mint of RawTitle; the other mint sites of every
level are listed in pkm.brand_registry.MINT_SITES.
"""
from __future__ import annotations

from typing import NewType

from pkm.contracts.brands import brand

RawTitle = NewType("RawTitle", str)
brand(RawTitle)
NormalizedTitle = NewType("NormalizedTitle", RawTitle)
# Its own brand: a NewType of a branded NewType otherwise inherits its
# parent's marker.
brand(NormalizedTitle)
CanonicalTitle = NewType("CanonicalTitle", NormalizedTitle)
brand(CanonicalTitle)


def as_raw_title(text: str) -> RawTitle:
    """Mark text as a title no check has run on."""
    return RawTitle(text)
