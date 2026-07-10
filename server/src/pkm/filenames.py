# pattern: Functional Core
"""Bound untrusted filenames to a safe, portable path component.

Shared by the upload route (pkm.server.routes_assets) and the exporter
(pkm.export.writer): both need the same normalization because DB rows
written before this bound existed may already hold unsafe names, and
direct API clients (a supported use case) can submit arbitrary filenames
that a browser's file picker never would.
"""
from __future__ import annotations

import re

_UNSAFE_RE = re.compile(r"[/\\:\x00-\x1f]")

# Most filesystems (APFS included) cap a path component at 255 bytes;
# leave headroom for callers that append a "(N)" dedup suffix or similar.
MAX_FILENAME_BYTES = 200
# Bound the extension separately so a pathological "extension" (e.g. a
# single dot followed by hundreds of characters) can't consume the whole
# budget and starve the stem.
MAX_EXTENSION_BYTES = 20

DEFAULT_STEM = "file"


def truncate_utf8(text: str, limit: int) -> str:
    """Truncate `text` to at most `limit` UTF-8 bytes without splitting a
    multibyte character."""
    encoded = text.encode("utf-8")
    if len(encoded) <= limit:
        return text
    return encoded[:limit].decode("utf-8", "ignore")


def _split_extension(name: str) -> tuple[str, str]:
    """Split into (stem, ext); ext includes the leading dot, if any.

    A leading dot (e.g. ".png") is treated as an extension with an empty
    stem rather than as "no extension" -- that keeps the usable extension
    intact for callers that fall back to DEFAULT_STEM.
    """
    dot = name.rfind(".")
    if dot == -1:
        return name, ""
    return name[:dot], name[dot:]


def safe_filename(name: str, max_bytes: int = MAX_FILENAME_BYTES) -> str:
    """Normalize an untrusted filename into a safe, bounded path component.

    - Replaces filesystem-unsafe characters (path separators, control
      characters) with '-'.
    - Falls back to DEFAULT_STEM for '.', '..', and names that are empty
      or whitespace/dots only.
    - Falls back to DEFAULT_STEM for the stem when a name is only an
      extension (e.g. ".png" -> "file.png").
    - Truncates by UTF-8 encoded byte length (never splitting a multibyte
      character), bounding the extension so it can't consume the whole
      budget, while preserving a usable extension.
    """
    cleaned = _UNSAFE_RE.sub("-", name)
    if cleaned.strip(" .") == "":
        cleaned = DEFAULT_STEM
    stem, ext = _split_extension(cleaned)
    ext = truncate_utf8(ext, MAX_EXTENSION_BYTES)
    stem = stem.strip(" .") or DEFAULT_STEM
    stem_limit = max(max_bytes - len(ext.encode("utf-8")), len(DEFAULT_STEM))
    stem = truncate_utf8(stem, stem_limit).strip(" .") or DEFAULT_STEM
    return f"{stem}{ext}"
