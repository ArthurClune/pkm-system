# pattern: Functional Core
"""Detect Roam firebase asset URLs in block text and rewrite to local paths."""
from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass

_FIREBASE_URL = re.compile(
    r"https://firebasestorage\.googleapis\.com/[^\s\)\]\}\"']+"
)


@dataclass(frozen=True)
class Asset:
    sha256: str
    filename: str
    mime: str
    size: int


def url_basename(url: str) -> str:
    path = urllib.parse.unquote(urllib.parse.urlparse(url).path)
    return path.rsplit("/", 1)[-1]


def rewrite_asset_urls(
    text: str, by_name: dict[str, Asset]
) -> tuple[str, frozenset[str], frozenset[str]]:
    used: set[str] = set()
    missing: set[str] = set()

    def _sub(m: re.Match[str]) -> str:
        url = m.group()
        asset = by_name.get(url_basename(url).lower())
        if asset is None:
            missing.add(url)
            return url
        used.add(asset.sha256)
        quoted = urllib.parse.quote(asset.filename)
        return f"/assets/{asset.sha256}/{quoted}"

    return _FIREBASE_URL.sub(_sub, text), frozenset(used), frozenset(missing)
