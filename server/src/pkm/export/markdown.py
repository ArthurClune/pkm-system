# pattern: Functional Core
"""Render one page's block tree as portable, self-contained markdown.

The export layout the paths assume (writer.py owns it):
  export/pages/<title>.md, export/journal/YYYY-MM-DD.md  <- one level deep
  export/assets/<sha256>/<filename>                      <- hence ../assets/
"""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING

from pkm.contracts.titles import CanonicalTitle
from pkm.filenames import dash_unwritable, fs_dedupe_key, truncate_utf8
from pkm.refs import BLOCK_REF_TOKEN

if TYPE_CHECKING:
    from pkm.contracts.responses import BlockNode

_ASSET_LINK_RE = re.compile(r"\]\(/assets/")
_BLOCK_REF_RE = re.compile(rf"\(\(({BLOCK_REF_TOKEN})\)\)")
_UNSAFE_RE = re.compile(r"[/\\:\x00-\x1f]")
# APFS caps filename components at 255 bytes; leave room for " (N)" + ".md".
_MAX_BASE_BYTES = 200


def rewrite_asset_links(text: str) -> str:
    return _ASSET_LINK_RE.sub("](../assets/", text)


def resolve_block_refs(text: str, uid_to_text: Mapping[str, str]) -> str:
    return _BLOCK_REF_RE.sub(
        lambda m: f"(({uid_to_text[m.group(1)]}))"
        if m.group(1) in uid_to_text else m.group(0), text)


def page_filename(title: CanonicalTitle, taken: set[str]) -> str:
    """Unique '<sanitized title>.md' against `taken`, comparing names as
    APFS does: Unicode-normalised and case-folded. Adds the chosen key
    to `taken`. Code points
    the filesystem refuses become '-', and two titles that sanitize alike
    still get distinct names."""
    base = (truncate_utf8(
        dash_unwritable(_UNSAFE_RE.sub("-", title)).strip(" ."),
        _MAX_BASE_BYTES).rstrip(" .") or "untitled")
    name, n = f"{base}.md", 2
    while fs_dedupe_key(name) in taken:
        name = f"{base} ({n}).md"
        n += 1
    taken.add(fs_dedupe_key(name))
    return name


def render_page(title: CanonicalTitle, tree: Sequence[BlockNode],
                uid_to_text: Mapping[str, str]) -> str:
    lines = [f"# {title}", ""]

    def walk(nodes: Sequence[BlockNode], depth: int) -> None:
        pad = "  " * depth
        for node in nodes:
            text = rewrite_asset_links(
                resolve_block_refs(node.text, uid_to_text))
            first, *rest = text.split("\n")
            lines.append(f"{pad}- {first}")
            lines.extend(f"{pad}  {line}" for line in rest)
            walk(node.children, depth + 1)

    walk(tree, 0)
    return "\n".join(lines) + "\n"
