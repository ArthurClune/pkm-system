# pattern: Functional Core
"""Pure helpers for the asset file browser: reference-token
stripping, mime categorisation (and its SQL twin), and zip arcname
de-duplication. Also the sha256 hashing and repair decision
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


def _markdown_destination_close(text: str, start: int) -> int:
    """Index of the ')' closing a link destination that starts at `start`.
    Parens inside it nest, so "Programme (Public).pdf" stays whole. When
    they do not balance before the end of the line, the first ')' closes.
    The same rule as the web's scanDestinationClose
    (web/src/grammar/markdown.ts), so a delete strips exactly the link the
    web rendered."""
    depth = 0
    i = start
    while i < len(text) and text[i] != "\n":
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            if depth == 0:
                return i
            depth -= 1
        i += 1
    return text.find(")", start)


def _markdown_link_span_at(text: str, start: int) -> tuple[int, int, str] | None:
    """(span_start, span_end, destination) of the markdown link or image
    opening at `start`, or None. Brackets in the label nest, and a newline
    in the label or destination means no link, as in the web's
    scanMarkdownLinkAt."""
    image = text[start] == "!"
    open_ = start + 1 if image else start
    if (open_ >= len(text) or text[open_] != "["
            or text.startswith("[[", open_)):
        return None
    depth = 1
    cursor = open_ + 1
    while cursor < len(text) and depth > 0:
        if text[cursor] == "\n":
            return None
        if text[cursor] == "[":
            depth += 1
        elif text[cursor] == "]":
            depth -= 1
        cursor += 1
    if depth != 0 or cursor >= len(text) or text[cursor] != "(":
        return None
    close = _markdown_destination_close(text, cursor + 1)
    if close == -1 or "\n" in text[cursor + 1:close]:
        return None
    return start, close + 1, text[cursor + 1:close]


def _strip_markdown_asset_links(text: str, prefix: str) -> str:
    """Remove every "[label](url)" / "![alt](url)" span whose destination
    starts with `prefix`, scanning left to right as the web's
    scanMarkdownLinks does. "[[page]]" never opens a span."""
    out: list[str] = []
    cursor = 0
    n = len(text)
    while cursor < n:
        looks_like_link = (
            (text[cursor] == "!" and text[cursor + 1:cursor + 2] == "[")
            or (text[cursor] == "[" and not text.startswith("[[", cursor)))
        span = _markdown_link_span_at(text, cursor) if looks_like_link else None
        if span is not None:
            span_start, span_end, destination = span
            if not destination.startswith(prefix):
                out.append(text[span_start:span_end])
            cursor = span_end
        else:
            out.append(text[cursor])
            cursor += 1
    return "".join(out)


def strip_asset_tokens(text: str, sha256: str) -> str:
    """Remove every reference to /assets/<sha256>/... from block text.
    Uploads write the raw filename into the URL, so it may hold spaces
    and parens. Three passes, in order: markdown link and image tokens,
    found with the web's scan; {{[[pdf]]: url}} and {{pdf: url}} macros,
    whose url runs to the closing "}}" on its line; then any bare URL
    left over, which ends at whitespace. Collapses doubled spaces and
    trims, so callers can test emptiness with a plain falsy check."""
    prefix = f"/assets/{sha256}/"
    text = _strip_markdown_asset_links(text, prefix)
    macro = (r"\{\{(?:\[\[pdf\]\]|pdf):\s*" + re.escape(prefix)
             + r"[^\n]*?\}\}")
    text = re.sub(macro, "", text)
    bare_url = re.escape(prefix) + r"[^\s)}]*"
    text = re.sub(bare_url, "", text)
    return re.sub(r" {2,}", " ", text).strip()


def sha256_hex(data: bytes) -> str:
    """The digest callers compare against a content-addressed asset's
    known sha256."""
    return hashlib.sha256(data).hexdigest()


def asset_needs_repair(expected_sha256: str, expected_size: int,
                       actual_size: int, actual_sha256: str | None) -> bool:
    """Whether a content-addressed asset file on disk must be rewritten
    from its known-good source.

    Production callers reach this through
    `assets_disk.asset_on_disk_needs_repair`, which owns the stat/read
    side of the ritual; this is the decision it feeds.

    Callers gather `actual_size` with a plain stat() first -- a size
    mismatch alone already proves corruption (e.g. truncation), so pass
    `actual_sha256=None` in that case rather than paying for a full read
    + hash of a file already known to be wrong. Only compute and pass
    the real hash once the sizes already agree, to also catch a
    same-size corruption (bit rot, a same-length overwrite)."""
    if actual_size != expected_size:
        return True
    return actual_sha256 != expected_sha256


def export_limit_violation(count: int, total_bytes: int, *,
                           max_count: int, max_bytes: int) -> str | None:
    """None if a selected-asset export's `count` and `total_bytes` both sit
    within their limits; otherwise a human-readable detail naming which
    limit was exceeded and by how much, for a 413 response. Callers must
    refuse the whole request on a violation -- never build a truncated
    archive that silently drops the assets over the line.

    Count is checked first: it is the cheaper number for a user to act on
    (deselect a few files) than a byte total, so when a request blows both
    limits at once the message leads with the more actionable one."""
    if count > max_count:
        return (f"selection has {count} assets, exceeding the limit of "
                f"{max_count}")
    if total_bytes > max_bytes:
        return (f"selection totals {total_bytes} bytes, exceeding the "
                f"limit of {max_bytes} bytes")
    return None


def zip_arcnames(entries: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Map (sha256, filename) pairs to unique zip arcnames: first use of
    a name wins (case-insensitively, since zips get extracted on
    case-insensitive filesystems), later collisions get ' (<sha8>)'
    before the suffix.

    A generated candidate can itself already be taken -- by another
    entry's original filename that merely looks generated, or by
    another entry whose sha256 shares the same 8-char prefix -- so the
    candidate is rechecked against `used` and, if still colliding, the
    sha prefix is extended one character at a time up to its full
    length. In the residual case of two entries sharing both name and
    full sha256, even the full digest can't disambiguate them, so an
    incrementing numeric suffix is the final fallback. Every returned
    arcname is guaranteed unique modulo case."""
    used: set[str] = set()
    out: list[tuple[str, str]] = []
    for sha, name in entries:
        arc = name
        if arc.lower() in used:
            p = PurePosixPath(name)
            prefix_len = 8
            arc = f"{p.stem} ({sha[:prefix_len]}){p.suffix}"
            while arc.lower() in used and prefix_len < len(sha):
                prefix_len += 1
                arc = f"{p.stem} ({sha[:prefix_len]}){p.suffix}"
            n = 2
            while arc.lower() in used:
                arc = f"{p.stem} ({sha[:prefix_len]}-{n}){p.suffix}"
                n += 1
        used.add(arc.lower())
        out.append((sha, arc))
    return out
