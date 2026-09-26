# pattern: Functional Core
"""Classify traced SQL and EXPLAIN QUERY PLAN rows for the backend check."""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping

_PLANNABLE = ("SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "REPLACE")

# Words that can follow an unaliased table name; never an alias.
_NOT_ALIAS = frozenset({
    "WHERE", "ON", "USING", "JOIN", "LEFT", "RIGHT", "FULL", "INNER", "OUTER",
    "CROSS", "NATURAL", "GROUP", "ORDER", "LIMIT", "HAVING", "WINDOW", "UNION",
    "EXCEPT", "INTERSECT", "INDEXED", "NOT", "RETURNING", "SET", "VALUES",
    "AND", "OR", "WHEN", "THEN", "ELSE", "END", "AS"})

# The alias word is only consumed as part of the match when it is not one of
# _NOT_ALIAS: otherwise an unaliased table directly followed by JOIN (`FROM
# blocks JOIN pages p`) would have its match swallow "JOIN" as a bogus alias
# for "blocks", leaving nothing at that position for the next JOIN to match
# against and dropping the real alias ("p" for "pages") entirely.
_KEYWORDS = "|".join(sorted(_NOT_ALIAS))
_ALIASED = re.compile(
    rf"\b(?:FROM|JOIN)\s+(\w+)(?:\s+AS\s+(\w+)|\s+(?!(?:{_KEYWORDS})\b)(\w+))?",
    re.IGNORECASE)


def plannable(sql: str) -> bool:
    return sql.lstrip().upper().startswith(_PLANNABLE)


def aliases(sql: str) -> dict[str, str]:
    """alias -> name for `FROM t a` / `JOIN t AS a` in one statement.
    EXPLAIN QUERY PLAN names an aliased table by its alias (`SCAN b`)."""
    out = {}
    for m in _ALIASED.finditer(sql):
        alias = m[2] or m[3]
        if alias:
            out[alias] = m[1]
    return out


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
