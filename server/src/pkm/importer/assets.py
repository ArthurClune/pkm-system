# pattern: Functional Core
"""Detect Roam firebase asset URLs in block text and rewrite to local paths."""
from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass
from typing import NamedTuple

from pkm.contracts.ops import Sha256Hex

_FIREBASE_URL = re.compile(
    r"https://firebasestorage\.googleapis\.com/[^\s\)\]\}\"']+"
)

# Roam's linked-files download names files "<10-char-uid>-<original name>.<ext>",
# while firebase URLs in block text use "<10-char-uid>.<ext>" or
# "<10-char-uid>.<truncated original>.<ext>" as the basename. Matching on just
# the leading uid prefix is what lets the two naming schemes line up.
UID_PREFIX_LEN = 10


@dataclass(frozen=True)
class Asset:
    sha256: Sha256Hex
    filename: str
    mime: str
    size: int


def url_basename(url: str) -> str:
    path = urllib.parse.unquote(urllib.parse.urlparse(url).path)
    return path.rsplit("/", 1)[-1]


class AssetUrlRewrite(NamedTuple):
    """`rewrite_asset_urls` accumulates two frozensets of strings across
    every block it scans, confusable with each other since both are
    frozenset[str]-shaped: `used` names asset hashes a rewritten URL
    actually linked, `missing` names firebase URLs no local asset
    matched. Naming them kills the swap a plain 2-tuple invites."""
    used: frozenset[Sha256Hex]
    missing: frozenset[str]


def rewrite_asset_urls(
    text: str, by_name: dict[str, Asset]
) -> tuple[str, AssetUrlRewrite]:
    used: set[Sha256Hex] = set()
    missing: set[str] = set()

    def _sub(m: re.Match[str]) -> str:
        url = m.group()
        # Trim trailing sentence punctuation
        trailing_punct = ""
        while url and url[-1] in ".,;:!?":
            trailing_punct = url[-1] + trailing_punct
            url = url[:-1]

        base = url_basename(url).lower()
        asset = by_name.get(base) or by_name.get(base[:UID_PREFIX_LEN])
        if asset is None:
            missing.add(url)
            return url + trailing_punct
        used.add(asset.sha256)
        quoted = urllib.parse.quote(asset.filename)
        return f"/assets/{asset.sha256}/{quoted}" + trailing_punct

    new_text = _FIREBASE_URL.sub(_sub, text)
    return new_text, AssetUrlRewrite(frozenset(used), frozenset(missing))
