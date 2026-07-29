# pattern: Functional Core
"""Pure helpers for the asset file browser (pkm-jdu3): reference-token
stripping, mime categorisation (and its SQL twin), and zip arcname
de-duplication."""
from __future__ import annotations

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
