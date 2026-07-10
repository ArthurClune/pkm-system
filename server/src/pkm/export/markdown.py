# pattern: Functional Core
"""Render one page's block tree as portable, self-contained markdown.

The export layout the paths assume (writer.py owns it):
  export/pages/<title>.md, export/journal/YYYY-MM-DD.md  <- one level deep
  export/assets/<sha256>/<filename>                      <- hence ../assets/
"""
from __future__ import annotations

import re
from collections.abc import Mapping

from pkm.filenames import truncate_utf8

_ASSET_LINK_RE = re.compile(r"\]\(/assets/")
_BLOCK_REF_RE = re.compile(r"\(\(([A-Za-z0-9_-]+)\)\)")
_UNSAFE_RE = re.compile(r"[/\\:\x00-\x1f]")
# APFS caps filename components at 255 bytes; leave room for " (N)" + ".md".
_MAX_BASE_BYTES = 200


def rewrite_asset_links(text: str) -> str:
    return _ASSET_LINK_RE.sub("](../assets/", text)


def resolve_block_refs(text: str, uid_to_text: Mapping[str, str]) -> str:
    return _BLOCK_REF_RE.sub(
        lambda m: f"(({uid_to_text[m.group(1)]}))"
        if m.group(1) in uid_to_text else m.group(0), text)


def page_filename(title: str, taken: set[str]) -> str:
    """Unique '<sanitized title>.md'; case-insensitive against `taken`
    (APFS default). Adds the chosen lowercase key to `taken`."""
    base = (truncate_utf8(_UNSAFE_RE.sub("-", title).strip(" ."), _MAX_BASE_BYTES)
           .rstrip(" .") or "untitled")
    name, n = f"{base}.md", 2
    while name.lower() in taken:
        name = f"{base} ({n}).md"
        n += 1
    taken.add(name.lower())
    return name


def render_page(title: str, tree: list[dict],
                uid_to_text: Mapping[str, str]) -> str:
    lines = [f"# {title}", ""]

    def walk(nodes: list[dict], depth: int) -> None:
        pad = "  " * depth
        for node in nodes:
            text = rewrite_asset_links(
                resolve_block_refs(node["text"], uid_to_text))
            first, *rest = text.split("\n")
            lines.append(f"{pad}- {first}")
            lines.extend(f"{pad}  {line}" for line in rest)
            walk(node["children"], depth + 1)

    walk(tree, 0)
    return "\n".join(lines) + "\n"
