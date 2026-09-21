# pattern: Functional Core
"""Pure decisions behind GET /api/local/{path}: is a URL path a safe
relative path under the configured root, how should a file be served,
and what does the link form of a `Local copy::` value look like. No I/O
here; routes_local.py stats the filesystem and calls in.

The containment rule (`clean_relative`/`resolve_relative` + `is_within`)
is the only thing standing between an authenticated client and the rest
of the disk. Never loosen it for convenience: a path that fails here is
a 404, not a warning.

Two decode paths, exactly one `unquote` each: uvicorn already
percent-decodes the `{path:path}` route parameter before FastAPI binds
it, so the file route calls `clean_relative` directly on that decoded
string. `/api/local/check` starts from a raw, still-encoded href found
in block text, so it calls `resolve_relative`, which decodes once and
then defers to `clean_relative`. Decoding twice on the file route would
make it disagree with `check` for any filename containing a literal
percent sign."""
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
# a closing bracket/paren. Stopping at `)` is only safe because
# `local_href` percent-encodes `(` and `)` in the path it generates: if
# that `safe=` set is ever widened to let parentheses through raw, this
# regex must be widened to match, or a hand-authored parenthesis in a
# filename will truncate the extracted href.
_HREF_RE = re.compile(r"\]\((/api/local/[^)\s]+)\)|(?<![\w(])(/api/local/[^\s)\]]+)")


def clean_relative(decoded: str) -> str | None:
    """Validate an already-decoded path and return it as a clean
    relative path, or None if it is empty, absolute, uses backslashes,
    contains a NUL, or has any `.`/`..` segment. Duplicate slashes
    collapse; a trailing slash is dropped. Does no decoding itself: the
    caller decides whether and how many times to `unquote` first."""
    if not decoded or "\x00" in decoded or "\\" in decoded:
        return None
    if decoded.startswith("/"):
        return None
    segments = [s for s in decoded.split("/") if s != ""]
    if not segments or any(s in (".", "..") for s in segments):
        return None
    return "/".join(segments)


def resolve_relative(url_path: str) -> str | None:
    """Percent-decode `url_path` once and return it as a clean relative
    path via `clean_relative`, or None if it is invalid. For callers
    that start from a raw, still-encoded href (e.g. one found in block
    text). Uvicorn already decodes the `{path:path}` route parameter, so
    the file route calls `clean_relative` directly instead of this."""
    return clean_relative(unquote(url_path))


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
