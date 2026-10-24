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


# The page a blank page title in an op is filed under.
UNTITLED_PAGE_TITLE = as_raw_title("Untitled")


# The whitespace a title's runs fold by: Unicode's White_Space property, in
# code point order. Neither Python's isspace/`\s` (it adds U+001C-U+001F)
# nor JS's `\s` (it adds U+FEFF) is this set, so the web gets it generated
# from here (pkm.title_whitespace_dump), never from its own `\s`. Look-alikes
# outside it (U+180E, the zero-width U+200B-U+200D, U+FEFF) stay byte-exact.
TITLE_WHITESPACE = (
    "\t\n\v\f\r \x85\xa0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)
