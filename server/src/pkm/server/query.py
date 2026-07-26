# pattern: Functional Core
"""Parse Roam's {{[[query]]}} expression syntax and plan it as SQL set ops.

Supported: {and: ...} {or: ...} {not: ...} over [[Page Title]] operands,
arbitrarily nested. `not` is only valid inside `and` (matching Roam).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

_OP_RE = re.compile(r"\{\s*([a-zA-Z-]+)\s*:")


class QueryParseError(ValueError):
    pass


# Excludes a query's own matching blocks from its results (a block whose
# text IS a {{query: ...}} macro, not one it merely returned): shared by
# routes_search.run_query (live /api/query) and routes_export's resolved
# single-page export (pkm-kplp), which both execute the same plan_sql().
QUERY_SOURCE_FILTER = (
    "NOT (ltrim(b.text) LIKE '{{[[query]]:%' OR ltrim(b.text) LIKE '{{query:%')"
)


@dataclass(frozen=True)
class QueryNode:
    kind: str  # 'and' | 'or' | 'not' | 'page'
    title: str | None = None
    children: tuple["QueryNode", ...] = ()


def parse_query(expr: str) -> QueryNode:
    node, pos = _parse_node(expr, _skip_ws(expr, 0))
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


def _parse_node(s: str, pos: int) -> tuple[QueryNode, int]:
    if s.startswith("[[", pos):
        title, pos = _parse_title(s, pos)
        return QueryNode("page", title), pos
    m = _OP_RE.match(s, pos)
    if not m:
        raise QueryParseError(f"expected '[[' or '{{' at offset {pos}")
    op = m.group(1).lower()
    if op not in ("and", "or", "not"):
        raise QueryParseError(f"unsupported clause: {op}")
    pos = m.end()
    children: list[QueryNode] = []
    while True:
        pos = _skip_ws(s, pos)
        if pos >= len(s):
            raise QueryParseError("unterminated clause")
        if s[pos] == "}":
            pos += 1
            break
        child, pos = _parse_node(s, pos)
        children.append(child)
    if not children:
        raise QueryParseError(f"empty {op} clause")
    if op == "not" and len(children) != 1:
        raise QueryParseError("not takes exactly one operand")
    if op != "and" and any(c.kind == "not" for c in children):
        raise QueryParseError("not is only valid inside and")
    return QueryNode(op, None, tuple(children)), pos


def _parse_title(s: str, pos: int) -> tuple[str, int]:
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
    return s[pos + 2:j - 2], j


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


def page_operands(node: QueryNode) -> list[str]:
    """Distinct [[Page]] operand titles in an expression, first-seen order
    (drives /api/query's ref_counts hint)."""
    if node.kind == "page":
        assert node.title is not None
        return [node.title]
    out: list[str] = []
    for c in node.children:
        for title in page_operands(c):
            if title not in out:
                out.append(title)
    return out


def plan_sql(node: QueryNode, expand: bool = False) -> tuple[str, list[str]]:
    if node.kind == "page":
        assert node.title is not None  # page nodes always carry a title
        if expand:
            return _PAGE_SQL_EXPANDED, [node.title, node.title]
        return _PAGE_SQL, [node.title]
    if node.kind == "not":  # only reachable nested inside and
        return plan_sql(node.children[0], expand)
    wrap = "SELECT uid FROM ({})"
    if node.kind == "or":
        parts, params = [], []
        for c in node.children:
            sql, p = plan_sql(c, expand)
            parts.append(wrap.format(sql))
            params.extend(p)
        return " UNION ".join(parts), params
    # and: INTERSECT positives, then EXCEPT each not-operand
    positives = [c for c in node.children if c.kind != "not"]
    negatives = [c.children[0] for c in node.children if c.kind == "not"]
    if not positives:
        raise QueryParseError("and needs at least one non-negated operand")
    parts, params = [], []
    for c in positives:
        sql, p = plan_sql(c, expand)
        parts.append(wrap.format(sql))
        params.extend(p)
    sql = " INTERSECT ".join(parts)
    for c in negatives:
        nsql, p = plan_sql(c, expand)
        sql += " EXCEPT " + wrap.format(nsql)
        params.extend(p)
    return sql, params
