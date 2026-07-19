# pattern: Functional Core
"""Block-start {{TODO}}/{{DONE}} marker helpers — the Python mirror of
web/src/grammar/todo.ts. The scanner there accepts each bracket side
independently (documented leniency), so the regex does too. Only a marker
at block start (after an exact '> ' quote prefix) counts."""
from __future__ import annotations

import re

_MARKER_RE = re.compile(
    r"^(?P<quote>> )?\{\{(?P<open>\[\[)?(?P<state>TODO|DONE)(?P<close>\]\])?\}\}")


def marker_state(text: str) -> str | None:
    m = _MARKER_RE.match(text)
    return m.group("state") if m else None


def is_todo(text: str) -> bool:
    return marker_state(text) == "TODO"


def with_state(text: str, state: str | None) -> str:
    """Return `text` with its task marker set to `state` ('TODO'/'DONE'),
    or stripped when state is None. Preserves the bracket variant and
    quote prefix; adding a marker to plain text uses the bare {{TODO}}
    form the web app emits."""
    m = _MARKER_RE.match(text)
    quote = (m.group("quote") if m else None) or (
        "> " if text.startswith("> ") else "")
    rest = text[m.end():] if m else text[len(quote):]
    if state is None:
        if m is None:
            return text
        return quote + (rest[1:] if rest.startswith(" ") else rest)
    if m is None:
        return f"{quote}{{{{{state}}}}} {rest}"
    marker = (f"{{{{{m.group('open') or ''}{state}"
              f"{m.group('close') or ''}}}}}")
    return quote + marker + rest


__all__ = ["marker_state", "is_todo", "with_state"]
