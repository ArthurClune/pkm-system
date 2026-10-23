# pattern: Functional Core
"""Parse Roam's {{[[query]]}} expression syntax and plan it as SQL set ops.

Supported: {and: ...} {or: ...} {not: ...} over [[Page Title]] operands,
arbitrarily nested. `not` is only valid inside `and` (matching Roam).
Running a plan is query_exec.py's job -- this module stays pure.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pkm.contracts.titles import CanonicalTitle, RawTitle, as_raw_title

_OP_RE = re.compile(r"\{\s*([a-zA-Z-]+)\s*:")


# Bounds on one expression. Depth keeps the recursive parser and planner far
# from the interpreter's recursion limit; operands keep the planned compound
# SELECT under SQLite's term limit (500), expand=True included, because each
# operand's two-part expansion sits in a subquery of its own.
MAX_QUERY_DEPTH = 32
MAX_QUERY_OPERANDS = 200


class QueryParseError(ValueError):
    pass


@dataclass(frozen=True)
class QueryNode[T: RawTitle]:
    """A query tree, generic in the kind of its page titles: `parse_query`
    gives `QueryNode[RawTitle]`, `query_exec.parse_canonical_query` gives
    `QueryNode[CanonicalTitle]`. The node is frozen, so it is covariant: a
    canonical tree passes where a raw one is expected, never the reverse --
    `plan_sql` takes the canonical kind only."""
    kind: str  # 'and' | 'or' | 'not' | 'page'
    # The page title of a 'page' node. Named for the operand, not `title`:
    # the brand-name rule wants a field so named to be a brand, and here the
    # brand is the type parameter.
    operand: T | None = None
    children: tuple[QueryNode[T], ...] = ()


def parse_query(expr: str) -> QueryNode[RawTitle]:
    node, pos = _parse_node(expr, _skip_ws(expr, 0), 0, _Operands())
    if node.kind == "page":
        raise QueryParseError("expected a {and: ...} or {or: ...} clause")
    if node.kind == "not":
        raise QueryParseError("a top-level not is unsupported")
    if _skip_ws(expr, pos) != len(expr):
        raise QueryParseError(f"trailing input at offset {pos}")
    return node


def _skip_ws(s: str, pos: int) -> int:
    while pos < len(s) and s[pos].isspace():
        pos += 1
    return pos


@dataclass
class _Operands:
    """Page operands seen so far in one parse, across every clause."""
    seen: int = 0


def _parse_node(s: str, pos: int, depth: int,
                operands: _Operands) -> tuple[QueryNode[RawTitle], int]:
    if s.startswith("[[", pos):
        operands.seen += 1
        if operands.seen > MAX_QUERY_OPERANDS:
            raise QueryParseError(
                f"query has more than {MAX_QUERY_OPERANDS} page operands")
        title, pos = _parse_title(s, pos)
        return QueryNode("page", title), pos
    m = _OP_RE.match(s, pos)
    if not m:
        raise QueryParseError(f"expected '[[' or '{{' at offset {pos}")
    if depth >= MAX_QUERY_DEPTH:
        raise QueryParseError(
            f"query nests deeper than {MAX_QUERY_DEPTH} levels")
    op = m.group(1).lower()
    if op not in ("and", "or", "not"):
        raise QueryParseError(f"unsupported clause: {op}")
    pos = m.end()
    children: list[QueryNode[RawTitle]] = []
    while True:
        pos = _skip_ws(s, pos)
        if pos >= len(s):
            raise QueryParseError("unterminated clause")
        if s[pos] == "}":
            pos += 1
            break
        child, pos = _parse_node(s, pos, depth + 1, operands)
        children.append(child)
    if not children:
        raise QueryParseError(f"empty {op} clause")
    if op == "not" and len(children) != 1:
        raise QueryParseError("not takes exactly one operand")
    if op != "and" and any(c.kind == "not" for c in children):
        raise QueryParseError("not is only valid inside and")
    return QueryNode(op, None, tuple(children)), pos


def _parse_title(s: str, pos: int) -> tuple[RawTitle, int]:
    depth, j = 1, pos + 2
    while j < len(s) - 1 and depth:
        pair = s[j:j + 2]
        if pair == "[[":
            depth, j = depth + 1, j + 2
        elif pair == "]]":
            depth, j = depth - 1, j + 2
        else:
            j += 1
    if depth:
        raise QueryParseError("unterminated [[title]]")
    return as_raw_title(s[pos + 2:j - 2]), j


_PAGE_SQL = ("SELECT r.src_block_uid AS uid FROM refs r"
             " JOIN pages p ON p.id = r.target_page_id WHERE p.title = ?")

# One-hop opt-in transitivity (expand=True): a block also matches [[X]] if
# it references a page whose own blocks reference X; all ref kinds count.
_PAGE_SQL_EXPANDED = (
    _PAGE_SQL
    + " UNION SELECT r.src_block_uid AS uid FROM refs r"
      " WHERE r.target_page_id IN ("
      "SELECT b2.page_id FROM refs r2"
      " JOIN blocks b2 ON b2.uid = r2.src_block_uid"
      " JOIN pages px ON px.id = r2.target_page_id WHERE px.title = ?)"
)


def page_operands[T: RawTitle](node: QueryNode[T]) -> list[T]:
    """Distinct [[Page]] operand titles in an expression, first-seen order
    (drives /api/query's ref_counts hint)."""
    if node.kind == "page":
        assert node.operand is not None
        return [node.operand]
    out: list[T] = []
    for c in node.children:
        for title in page_operands(c):
            if title not in out:
                out.append(title)
    return out


def plan_sql(node: QueryNode[CanonicalTitle],
            expand: bool = False) -> tuple[str, list[str]]:
    return _plan_sql(node, expand)


def _plan_sql(node: QueryNode[CanonicalTitle], expand: bool = False) -> tuple[str, list[str]]:
    if node.kind == "page":
        assert node.operand is not None  # page nodes always carry a title
        if expand:
            return _PAGE_SQL_EXPANDED, [node.operand, node.operand]
        return _PAGE_SQL, [node.operand]
    if node.kind == "not":  # only reachable nested inside and
        return _plan_sql(node.children[0], expand)
    wrap = "SELECT uid FROM ({})"
    parts: list[str] = []
    params: list[str] = []
    if node.kind == "or":
        for c in node.children:
            sql, p = _plan_sql(c, expand)
            parts.append(wrap.format(sql))
            params.extend(p)
        return " UNION ".join(parts), params
    # and: INTERSECT positives, then EXCEPT each not-operand
    positives = [c for c in node.children if c.kind != "not"]
    negatives = [c.children[0] for c in node.children if c.kind == "not"]
    if not positives:
        raise QueryParseError("and needs at least one non-negated operand")
    for c in positives:
        sql, p = _plan_sql(c, expand)
        parts.append(wrap.format(sql))
        params.extend(p)
    sql = " INTERSECT ".join(parts)
    for c in negatives:
        nsql, p = _plan_sql(c, expand)
        sql += " EXCEPT " + wrap.format(nsql)
        params.extend(p)
    return sql, params
