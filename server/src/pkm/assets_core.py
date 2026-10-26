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
from array import array
from pathlib import PurePosixPath
from urllib.parse import quote
from typing import Literal

from pkm.contracts.ops import SHA256_HEX_RE, Sha256Hex
from pkm.filenames import fs_dedupe_key

AssetCategory = Literal["image", "pdf", "document", "other"]

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


def mime_category(mime: str) -> AssetCategory:
    """The file-browser's coarse type buckets."""
    if mime.startswith("image/"):
        return "image"
    if mime == "application/pdf":
        return "pdf"
    if mime.startswith("text/") or mime in _DOCUMENT_MIME:
        return "document"
    return "other"


def type_where(category: AssetCategory) -> tuple[str, list[str]]:
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


def asset_url(sha256: Sha256Hex, filename: str) -> str:
    """The /assets/<sha256>/<name> URL of an upload. The name segment is
    percent-encoded (only letters, digits and `_.-~` stay), so spaces,
    brackets, parens, `%` and non-ASCII can never end a markdown link
    early. GET /assets/{sha256}/{filename} serves by sha and ignores the
    segment, so links written with a raw name before this keep working,
    and strip_asset_tokens removes both spellings."""
    return f"/assets/{sha256}/{quote(filename, safe='')}"


def asset_label(filename: str) -> str:
    """A file name as markdown link text: "[" and "]" become "(" and ")"
    so the label can never open "[[" or close early. Display only; the
    stored and downloaded name is untouched."""
    return filename.replace("[", "(").replace("]", ")")


def _closes_of(text: str) -> array[int]:
    """Where each "[" and "(" in `text` closes: one slot per character,
    the index of the "]" or ")" that closes it, else -1. Brackets and
    parens nest and pair only within a line, so "Programme (Public).pdf"
    stays whole. A "(" left unpaired on its line closes at the first ")"
    after it on that line. The same pairing as the web's closesOf
    (web/src/grammar/markdown.ts), so a delete strips exactly the link the
    web rendered, and one pass serves every probe, where scanning from
    each opener would rescan the line from every one."""
    closes = array("q", [-1]) * len(text)
    brackets: list[int] = []
    parens: list[int] = []
    for i, ch in enumerate(text):
        if ch == "\n":
            brackets.clear()
            parens.clear()
        elif ch == "[":
            brackets.append(i)
        elif ch == "(":
            parens.append(i)
        elif ch == "]" and brackets:
            closes[brackets.pop()] = i
        elif ch == ")" and parens:
            closes[parens.pop()] = i
    next_close = -1  # the first ")" after i on i's line
    for i in range(len(text) - 1, -1, -1):
        ch = text[i]
        if ch == "\n":
            next_close = -1
        elif ch == ")":
            next_close = i
        elif ch == "(" and closes[i] == -1:
            closes[i] = next_close
    return closes


def _markdown_link_span_at(text: str, start: int,
                           closes: array[int]) -> tuple[int, int, str] | None:
    """(span_start, span_end, destination) of the markdown link or image
    opening at `start`, or None, given where each opener closes
    (_closes_of). A label or destination that does not close on its line
    means no link, as in the web's scanMarkdownLinkAt."""
    open_ = start + 1 if text[start] == "!" else start
    if (open_ >= len(text) or text[open_] != "["
            or text.startswith("[[", open_)):
        return None
    label_close = closes[open_]
    if label_close == -1 or text[label_close + 1:label_close + 2] != "(":
        return None
    close = closes[label_close + 1]
    if close == -1:
        return None
    return start, close + 1, text[label_close + 2:close]


def _markdown_asset_spans(text: str, prefix: str) -> list[tuple[int, int]]:
    """(start, end) of every "[label](url)" / "![alt](url)" span whose
    destination starts with `prefix`, scanning left to right as the web's
    scanMarkdownLinks does. "[[page]]" never opens a span. The pairing is
    built once, on the first probe that reaches a "["."""
    spans: list[tuple[int, int]] = []
    closes: array[int] | None = None
    cursor = 0
    n = len(text)
    while cursor < n:
        looks_like_link = (
            (text[cursor] == "!" and text[cursor + 1:cursor + 2] == "[")
            or (text[cursor] == "[" and not text.startswith("[[", cursor)))
        span = None
        if looks_like_link:
            if closes is None:
                closes = _closes_of(text)
            span = _markdown_link_span_at(text, cursor, closes)
        if span is not None:
            span_start, span_end, destination = span
            if destination.startswith(prefix):
                spans.append((span_start, span_end))
            cursor = span_end
        else:
            cursor += 1
    return spans


def _macro_spans(text: str, prefix: str) -> list[tuple[int, int]]:
    """(start, end) of every {{[[pdf]]: url}} and {{pdf: url}} macro whose
    url starts with `prefix`. A macro closes at the first "}}" after its
    head, if that comes before the next newline; a head inside an earlier
    macro opens none. As a lazy regex would match, but the "}}" and the
    newline are found from a cursor that only moves forward, so unclosed
    heads on one line cost one pass over it, not one each."""
    head = re.compile(r"\{\{(?:\[\[pdf\]\]|pdf):\s*" + re.escape(prefix))
    spans: list[tuple[int, int]] = []
    end_of_last = 0
    close = newline = -2  # -2: not looked for yet; -1: none to the end
    for m in head.finditer(text):
        if m.start() < end_of_last:
            continue
        after = m.end()
        if close != -1 and close < after:
            close = text.find("}}", after)
        if newline != -1 and newline < after:
            newline = text.find("\n", after)
        if close != -1 and (newline == -1 or close < newline):
            end_of_last = close + 2
            spans.append((m.start(), end_of_last))
    return spans


def _remove_spans(text: str, spans: list[tuple[int, int]]) -> str:
    """`text` without the spans, plus one space beside each: the one
    before the span if there is one, else the one after it. Every other
    character is kept. Overlapping spans count once."""
    drop = bytearray(len(text))
    end_of_last = 0
    for start, end in sorted(spans):
        if start < end_of_last:
            continue
        end_of_last = end
        for i in range(start, end):
            drop[i] = 1
        if start > 0 and text[start - 1] == " " and not drop[start - 1]:
            drop[start - 1] = 1
        elif end < len(text) and text[end] == " ":
            drop[end] = 1
    return "".join(c for c, d in zip(text, drop) if not d)


def strip_asset_tokens(text: str, sha256: Sha256Hex) -> str:
    """Remove every reference to /assets/<sha256>/... from block text.
    Uploads now carry the percent-encoded name (asset_url), but older ones
    wrote the raw filename, which may hold spaces and parens. Three kinds
    of token: markdown link and image tokens, found with the web's scan;
    {{[[pdf]]: url}} and {{pdf: url}} macros, whose url runs to the
    closing "}}" on its line; and any bare URL left over, which ends at
    whitespace. A removed token takes one adjacent space with it (the one
    before it, else the one after), so "see X here" becomes "see here";
    every other character is kept byte for byte. Text left holding only
    whitespace becomes "", so callers can test emptiness with a plain
    falsy check."""
    prefix = f"/assets/{sha256}/"
    spans = _markdown_asset_spans(text, prefix)
    spans += _macro_spans(text, prefix)
    bare_url = re.escape(prefix) + r"[^\s)}]*"
    spans += [m.span() for m in re.finditer(bare_url, text)]
    if not spans:
        return text
    rest = _remove_spans(text, spans)
    return rest if rest.strip() else ""


def sha256_hex(data: bytes) -> Sha256Hex:
    """The digest callers compare against a content-addressed asset's
    known sha256."""
    return Sha256Hex(hashlib.sha256(data).hexdigest())


def parse_sha256(text: str) -> Sha256Hex | None:
    """`text` as a Sha256Hex, or None when it is not 64 lowercase hex."""
    return Sha256Hex(text) if SHA256_HEX_RE.fullmatch(text) else None


def hasher_hex(hasher: "hashlib._Hash") -> Sha256Hex:
    """The digest of a streaming sha256 hasher."""
    return Sha256Hex(hasher.hexdigest())


def asset_needs_repair(expected_sha256: Sha256Hex, expected_size: int,
                       actual_size: int,
                       actual_sha256: Sha256Hex | None) -> bool:
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
    a name wins (as APFS compares names, Unicode-normalised and
    case-folded, since zips get extracted there), later collisions get
    ' (<sha8>)' before the suffix. Names must already be safe_filename'd:
    the key is exact only over code points Python knows as assigned.

    A generated candidate can itself already be taken -- by another
    entry's original filename that merely looks generated, or by
    another entry whose sha256 shares the same 8-char prefix -- so the
    candidate is rechecked against `used` and, if still colliding, the
    sha prefix is extended one character at a time up to its full
    length. In the residual case of two entries sharing both name and
    full sha256, even the full digest can't disambiguate them, so an
    incrementing numeric suffix is the final fallback. Every returned
    arcname is guaranteed unique under that comparison."""
    used: set[str] = set()
    out: list[tuple[str, str]] = []
    for sha, name in entries:
        arc = name
        if fs_dedupe_key(arc) in used:
            p = PurePosixPath(name)
            prefix_len = 8
            arc = f"{p.stem} ({sha[:prefix_len]}){p.suffix}"
            while fs_dedupe_key(arc) in used and prefix_len < len(sha):
                prefix_len += 1
                arc = f"{p.stem} ({sha[:prefix_len]}){p.suffix}"
            n = 2
            while fs_dedupe_key(arc) in used:
                arc = f"{p.stem} ({sha[:prefix_len]}-{n}){p.suffix}"
                n += 1
        used.add(fs_dedupe_key(arc))
        out.append((sha, arc))
    return out
