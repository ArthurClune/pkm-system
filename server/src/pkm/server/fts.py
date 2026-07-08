# pattern: Functional Core
"""Escape untrusted text into FTS5 MATCH expressions."""
from __future__ import annotations

import re


def _quote(term: str) -> str:
    return '"' + term.replace('"', '""') + '"'


def escape_fts_query(q: str) -> str:
    terms = [t for t in re.split(r"\s+", q.strip()) if t]
    if not terms:
        return '""'
    quoted = [_quote(t) for t in terms]
    quoted[-1] += "*"
    return " ".join(quoted)


def phrase_query(q: str) -> str:
    return _quote(q.strip())
