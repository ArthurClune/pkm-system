# pattern: Functional Core
"""Escape untrusted text into FTS5 MATCH expressions."""
from __future__ import annotations

import re


def _quote(term: str) -> str:
    return '"' + term.replace('"', '""') + '"'


def _no_nul(q: str) -> str:
    """FTS5 reads its query as a C string, so a NUL inside a quoted term
    ends the query mid-string ("unterminated string"). The tokenizer reads
    a NUL in indexed text as a separator, so a space stands in for it."""
    return q.replace("\x00", " ")


def escape_fts_query(q: str, exact: bool = False) -> str:
    terms = [t for t in re.split(r"\s+", _no_nul(q).strip()) if t]
    if not terms:
        return '""'
    quoted = [_quote(t) for t in terms]
    if not exact:
        quoted[-1] += "*"
    return " ".join(quoted)


def phrase_query(q: str) -> str:
    return _quote(_no_nul(q).strip())
