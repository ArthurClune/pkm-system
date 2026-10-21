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

import html
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Literal
from urllib.parse import quote, unquote

LOCAL_PREFIX = "/api/local/"

_INLINE_EXT = frozenset({".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"})

# Explicit table rather than `mimetypes.guess_type`: that call lazily
# reads the host's MIME registry on first use (hidden I/O in a Core
# module) and its answers vary by machine. Anything not listed is served
# as an opaque download.
_OCTET_STREAM = "application/octet-stream"
_MEDIA_TYPES: dict[str, str] = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".zip": "application/zip",
    ".epub": "application/epub+zip",
    ".html": "text/html",
    ".htm": "text/html",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".webarchive": _OCTET_STREAM,
}

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
    return _MEDIA_TYPES.get(Path(name).suffix.lower(), _OCTET_STREAM)


def local_href(rel: str) -> str:
    return LOCAL_PREFIX + quote(rel, safe="/")


def visible_name(name: str, is_dir: bool) -> str | None:
    """The name the local-file picker shows for a directory entry, or
    None to skip it. An evicted file's `.Name.ext.icloud` stub shows as
    `Name.ext`; every other dotfile or dot-directory is hidden."""
    if not is_dir and name.startswith(".") and name.endswith(".icloud"):
        real = name[1:-len(".icloud")]
        return real if real and not real.startswith(".") else None
    if name.startswith("."):
        return None
    return name


def index_order(rels: Iterable[str]) -> list[str]:
    """Distinct relative paths, case-insensitively sorted (case breaks
    ties) so the picker's empty-query list is stable."""
    return sorted(set(rels), key=lambda rel: (rel.casefold(), rel))


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


def wants_html_error(fetch_mode: str | None, fetch_dest: str | None,
                     accept: str | None) -> bool:
    """True when the request is a browser navigation (address bar, plain
    link, new tab) rather than a fetch()/pdf.js call. `Sec-Fetch-Mode:
    navigate` or `Sec-Fetch-Dest: document` decides when the browser sent
    Sec-Fetch-*; only a browser that sent neither falls back to an Accept
    that names text/html."""
    if fetch_mode is not None or fetch_dest is not None:
        return fetch_mode == "navigate" or fetch_dest == "document"
    return accept is not None and "text/html" in accept.lower()


def error_page_html(status: int, message: str, path: str | None) -> str:
    """A tiny self-contained HTML error page: no scripts, no external
    resources. `message` and `path` are escaped here; `path` is whatever
    the client asked for, never anything read from the disk."""
    shown = f"<p><code>{html.escape(path)}</code></p>" if path else ""
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{status} - local copy unavailable</title>"
        "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;"
        "margin:4rem auto;padding:0 1rem}code{word-break:break-all}</style>"
        "</head><body>"
        f"<h1>{status}: local copy unavailable</h1>"
        f"<p>{html.escape(message)}</p>{shown}</body></html>")
