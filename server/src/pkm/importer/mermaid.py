# pattern: Functional Core
"""Detect Roam mermaid component blocks and convert them to fenced blocks.

Roam represents a mermaid diagram as a component block whose text is a bare
{{[[mermaid]]}} (or {{mermaid}}) macro, with the diagram's source lines
living in that block's children as a depth-first outline (one source line
per child block, arbitrarily nested via sub-children for indented diagram
constructs like subgraphs). The web app instead expects a single block
whose text is a ```mermaid fenced code block, so both the Roam importer and
the one-off migration script for already-imported databases need this same
detection + flattening logic; it is shared here so the two imperative
shells (parse_export/rows.py at import time, migrate_mermaid.py for
existing databases) can't drift.

Childless {{[[mermaid]]}} mentions (e.g. a passing reference on the "Roam"
page, not an actual diagram) are left alone -- a child is required to
trigger conversion.
"""
from __future__ import annotations

import re
from typing import Protocol, Sequence

_TRIGGER = re.compile(r"^\s*\{\{(?:\[\[mermaid\]\]|mermaid)\}\}\s*$")


class MermaidNode(Protocol):
    """Structural shape needed from a block to run this conversion: its own
    text and its children in outline order. pkm.importer.parse_export.Block
    already satisfies this; the migration script builds a lightweight
    stand-in from database rows."""

    @property
    def text(self) -> str: ...

    @property
    def children(self) -> Sequence["MermaidNode"]: ...


def is_mermaid_trigger(text: str) -> bool:
    """True if text is exactly (ignoring surrounding whitespace) the Roam
    mermaid component macro, in either bracketed-link or bare spelling."""
    return bool(_TRIGGER.match(text))


def convert_to_fence(text: str, children: Sequence[MermaidNode]) -> str | None:
    """Return the ```mermaid fenced block text for a mermaid component
    block, or None if `text`/`children` don't describe one (wrong text, or
    no children -- a childless mention is left alone).

    The fence body is the descendant subtree's block texts flattened
    depth-first in outline order, each indented two spaces per nesting
    level relative to the component block itself (its direct children sit
    at indent 0).
    """
    if not children or not is_mermaid_trigger(text):
        return None
    lines: list[str] = []

    def walk(nodes: Sequence[MermaidNode], depth: int) -> None:
        for node in nodes:
            lines.append("  " * depth + node.text)
            walk(node.children, depth + 1)

    walk(children, 0)
    return "```mermaid\n" + "\n".join(lines) + "\n```"
