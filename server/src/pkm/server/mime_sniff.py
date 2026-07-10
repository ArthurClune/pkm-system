# pattern: Functional Core
"""Detect an asset's MIME type from its leading bytes.

The upload route (pkm.server.routes_assets) trusts the client-declared
Content-Type by default, but a client can lie about it. This module gives
a second, byte-derived opinion for the asset types the app actually
serves, so the stored metadata and the inline-vs-download decision don't
rest solely on an untrusted header.

Detection is deliberately narrow: it only claims a type when the magic
bytes are unambiguous. Everything else (including ZIP-based office
formats, which share a signature with plain ZIP) returns None so the
caller falls back to the client-declared type.
"""
from __future__ import annotations

_SVG_PREFIXES = (b"<?xml", b"<svg")
_SVG_SNIFF_WINDOW = 1024
_SVG_STRIP = b"\xef\xbb\xbf \t\r\n"


def _looks_like_svg(head: bytes) -> bool:
    text = head.lstrip(_SVG_STRIP).lower()
    if text.startswith(b"<svg"):
        return True
    if text.startswith(b"<?xml"):
        return b"<svg" in text[:_SVG_SNIFF_WINDOW]
    return False


def sniff_mime(head: bytes) -> str | None:
    """Return the confidently-detected MIME type for `head`, or None.

    `head` should be the first chunk of the upload (a few KB is enough
    for every signature checked here).
    """
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"GIF87a") or head.startswith(b"GIF89a"):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if _looks_like_svg(head):
        return "image/svg+xml"
    return None


def resolve_stored_mime(declared: str, sniffed: str | None) -> str:
    """Pick the MIME type to store and to base the inline decision on.

    Policy: prefer the sniffed type when byte detection is confident;
    otherwise trust the client-declared type.
    """
    return sniffed if sniffed is not None else declared
