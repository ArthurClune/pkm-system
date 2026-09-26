# pattern: Functional Core
"""Classify traced SQL and EXPLAIN QUERY PLAN rows for the backend check."""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping

_PLANNABLE = ("SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "REPLACE")

_ALIASED = re.compile(r"\b(?:FROM|JOIN)\s+(\w+)(?:\s+AS)?\s+(\w+)", re.IGNORECASE)
# Words that can follow an unaliased table name; never an alias.
_NOT_ALIAS = frozenset({
    "WHERE", "ON", "USING", "JOIN", "LEFT", "RIGHT", "FULL", "INNER", "OUTER",
    "CROSS", "NATURAL", "GROUP", "ORDER", "LIMIT", "HAVING", "WINDOW", "UNION",
    "EXCEPT", "INTERSECT", "INDEXED", "NOT", "RETURNING", "SET", "VALUES",
    "AND", "OR", "WHEN", "THEN", "ELSE", "END", "AS"})


def plannable(sql: str) -> bool:
    return sql.lstrip().upper().startswith(_PLANNABLE)


def aliases(sql: str) -> dict[str, str]:
    """alias -> name for `FROM t a` / `JOIN t AS a` in one statement.
    EXPLAIN QUERY PLAN names an aliased table by its alias (`SCAN b`)."""
    return {m[2]: m[1] for m in _ALIASED.finditer(sql) if m[2].upper() not in _NOT_ALIAS}


def full_scans(details: Iterable[str], tables: set[str],
               names: Mapping[str, str] | None = None) -> list[str]:
    """Plan rows that read a real table with no index. CTEs, constant rows
    and FTS virtual tables are not table scans in the sense that matters.
    `names` resolves aliases (see `aliases`); a CTE alias resolves to the
    CTE, which is not in `tables`."""
    names = names or {}
    out = []
    for d in details:
        if not d.startswith("SCAN ") or " USING " in d or "VIRTUAL TABLE" in d:
            continue
        name = d.split()[1]
        if names.get(name, name) in tables:
            out.append(d)
    return out
