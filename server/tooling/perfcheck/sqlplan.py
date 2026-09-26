# pattern: Functional Core
"""Classify traced SQL and EXPLAIN QUERY PLAN rows for the backend check."""
from __future__ import annotations

from collections.abc import Iterable

_PLANNABLE = ("SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "REPLACE")


def plannable(sql: str) -> bool:
    return sql.lstrip().upper().startswith(_PLANNABLE)


def full_scans(details: Iterable[str], tables: set[str]) -> list[str]:
    """Plan rows that read a real table with no index. CTEs, constant rows
    and FTS virtual tables are not table scans in the sense that matters."""
    out = []
    for d in details:
        if not d.startswith("SCAN ") or " USING " in d or "VIRTUAL TABLE" in d:
            continue
        name = d.split()[1]
        if name in tables:
            out.append(d)
    return out
