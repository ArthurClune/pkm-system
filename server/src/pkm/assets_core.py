# pattern: Functional Core
"""Pure helpers for the asset file browser (pkm-jdu3): reference-token
stripping, mime categorisation (and its SQL twin), and zip arcname
de-duplication. Also (pkm-x3l7) the sha256 hashing and repair decision
used to verify a content-addressed asset file's bytes actually match the
digest encoded in its own storage path, instead of trusting that a file
at that path is correct just because it exists."""
from __future__ import annotations

import hashlib
import re
from pathlib import PurePosixPath

# Office + JSON mimes that count as "document" alongside text/*. Keep in
# step with ALLOWED_UPLOAD_MIME in routes_assets.py.
_DOCUMENT_MIME = (
    "application/json",
    "application/msword", "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument"
    ".wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument"
    ".spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument"
    ".presentationml.presentation",
)


def mime_category(mime: str) -> str:
    """The file-browser's coarse type buckets."""
    if mime.startswith("image/"):
        return "image"
    if mime == "application/pdf":
        return "pdf"
    if mime.startswith("text/") or mime in _DOCUMENT_MIME:
        return "document"
    return "other"


def type_where(category: str) -> tuple[str, list[str]]:
    """SQL fragment + params selecting assets whose mime falls in
    `category`. Must agree with mime_category (tested against it)."""
    doc = ("(mime LIKE 'text/%' OR mime IN ({}))"
           .format(",".join("?" * len(_DOCUMENT_MIME))))
    if category == "image":
        return "mime LIKE 'image/%'", []
    if category == "pdf":
        return "mime = 'application/pdf'", []
    if category == "document":
        return doc, list(_DOCUMENT_MIME)
    return (f"NOT (mime LIKE 'image/%' OR mime = 'application/pdf'"
            f" OR {doc})", list(_DOCUMENT_MIME))


def strip_asset_tokens(text: str, sha256: str) -> str:
    """Remove every reference to /assets/<sha256>/... from block text:
    image/link markdown tokens, the {{[[pdf]]: url}} macro, then any
    bare URL left over. Collapses doubled spaces and trims, so callers
    can test emptiness with a plain falsy check."""
    url = r"/assets/" + re.escape(sha256) + r"/[^\s)}]*"
    for pattern in (r"!?\[[^\]]*\]\(" + url + r"\)",
                    r"\{\{\[\[pdf\]\]:\s*" + url + r"\}\}",
                    url):
        text = re.sub(pattern, "", text)
    return re.sub(r" {2,}", " ", text).strip()


def sha256_hex(data: bytes) -> str:
    """The digest callers compare against a content-addressed asset's
    known sha256."""
    return hashlib.sha256(data).hexdigest()


def asset_needs_repair(expected_sha256: str, expected_size: int,
                       actual_size: int, actual_sha256: str | None) -> bool:
    """Whether a content-addressed asset file on disk must be rewritten
    from its known-good source.

    Callers gather `actual_size` with a plain stat() first -- a size
    mismatch alone already proves corruption (e.g. truncation), so pass
    `actual_sha256=None` in that case rather than paying for a full read
    + hash of a file already known to be wrong. Only compute and pass
    the real hash once the sizes already agree, to also catch a
    same-size corruption (bit rot, a same-length overwrite)."""
    if actual_size != expected_size:
        return True
    return actual_sha256 != expected_sha256


def zip_arcnames(entries: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Map (sha256, filename) pairs to unique zip arcnames: first use of
    a name wins, later case-insensitive collisions get ' (<sha8>)'
    before the suffix."""
    used: set[str] = set()
    out: list[tuple[str, str]] = []
    for sha, name in entries:
        arc = name
        if arc.lower() in used:
            p = PurePosixPath(name)
            arc = f"{p.stem} ({sha[:8]}){p.suffix}"
        used.add(arc.lower())
        out.append((sha, arc))
    return out
