# pattern: Functional Core
"""Content-coding for the sync routes: gzip when the client accepts it.

Only a response whose body is notes and sync metadata goes through here. A
compressed length leaks how well its parts compress together, so a response
that carries a credential must never use this module.
"""
from __future__ import annotations

import gzip
import re

GZIP_MIN_BYTES = 1024
_GZIP_LEVEL = 6
_GZIP_NAMES = frozenset({"gzip", "x-gzip"})
_QVALUE = re.compile(r"(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)")


def _entry(raw: str) -> tuple[str, float] | None:
    """The coding name and q of one Accept-Encoding entry; None when its q
    cannot be read, which drops the entry."""
    name, *params = (part.strip() for part in raw.split(";"))
    quality = 1.0
    for param in params:
        key, sep, value = param.partition("=")
        if key.strip().lower() != "q":
            continue
        value = value.strip()
        if not sep or not _QVALUE.fullmatch(value):
            return None
        quality = float(value)
    return (name.lower(), quality) if name else None


def accepts_gzip(header: str | None) -> bool:
    """True when `gzip` (or `x-gzip`) has q > 0, or `*` has q > 0 and no
    entry names gzip with q = 0. Never raises."""
    if not header:
        return False
    named: list[float] = []
    star: float | None = None
    for raw in header.split(","):
        parsed = _entry(raw)
        if parsed is None:
            continue
        name, quality = parsed
        if name in _GZIP_NAMES:
            named.append(quality)
        elif name == "*":
            star = quality
    if named:
        return max(named) > 0
    return star is not None and star > 0


def encode_body(body: bytes,
                accept_encoding: str | None) -> tuple[bytes, dict[str, str]]:
    """The body to send and the headers to add. `Vary` is always present so a
    cache never serves one encoding to a client that wanted the other."""
    headers = {"Vary": "Accept-Encoding"}
    if len(body) < GZIP_MIN_BYTES or not accepts_gzip(accept_encoding):
        return body, headers
    headers["Content-Encoding"] = "gzip"
    return gzip.compress(body, compresslevel=_GZIP_LEVEL, mtime=0), headers
