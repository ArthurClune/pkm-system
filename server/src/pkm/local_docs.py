# pattern: Functional Core
"""Pure decisions behind GET /api/local/{path}: is a URL path a safe
relative path under the configured root, how should a file be served,
and what does the link form of a `Local copy::` value look like. No I/O
here; routes_local.py stats the filesystem and calls in.

The containment rule (`resolve_relative` + `is_within`) is the only
thing standing between an authenticated client and the rest of the
disk. Never loosen it for convenience: a path that fails here is a 404,
not a warning."""
from __future__ import annotations

import mimetypes
import re
from pathlib import Path
from typing import Literal
from urllib.parse import quote, unquote

LOCAL_PREFIX = "/api/local/"

_INLINE_EXT = frozenset({".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"})

# `[text](/api/local/...)` targets and bare `/api/local/...` tokens. The
# link target stops at the closing paren; a bare token at whitespace or
# a closing bracket/paren.
_HREF_RE = re.compile(r"\]\((/api/local/[^)\s]+)\)|(?<![\w(])(/api/local/[^\s)\]]+)")


def resolve_relative(url_path: str) -> str | None:
    """Percent-decode `url_path` and return it as a clean relative path,
    or None if it is empty, absolute, uses backslashes, contains a NUL,
    or has any `.`/`..` segment. Duplicate slashes collapse; a trailing
    slash is dropped."""
    decoded = unquote(url_path)
    if not decoded or "\x00" in decoded or "\\" in decoded:
        return None
    if decoded.startswith("/"):
        return None
    segments = [s for s in decoded.split("/") if s != ""]
    if not segments or any(s in (".", "..") for s in segments):
        return None
    return "/".join(segments)


def disposition_for(name: str) -> Literal["inline", "attachment"]:
    return "inline" if Path(name).suffix.lower() in _INLINE_EXT else "attachment"


def media_type_for(name: str) -> str:
    guessed, _ = mimetypes.guess_type(name)
    return guessed or "application/octet-stream"


def local_href(rel: str) -> str:
    return LOCAL_PREFIX + quote(rel, safe="/")


def extract_local_hrefs(text: str) -> list[str]:
    seen: list[str] = []
    for m in _HREF_RE.finditer(text):
        href = m.group(1) or m.group(2)
        if href not in seen:
            seen.append(href)
    return seen


def is_within(root: Path, candidate: Path) -> bool:
    """True when `candidate` is `root` or below it. Both must already be
    resolved (symlinks followed) by the caller."""
    return candidate == root or root in candidate.parents
