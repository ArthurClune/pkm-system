---
# pkm-5s0h
title: Query tree titles carry their kind (CanonicalQueryNode holds RawTitle)
status: completed
type: task
priority: low
created_at: 2026-10-20T12:14:18Z
updated_at: 2026-10-20T12:14:18Z
---

A parsed query tree types its page titles as raw even after they are
canonicalized. `QueryNode.title` is `RawTitle | None`, and
`CanonicalQueryNode` is a NewType over `QueryNode`: the canonical guarantee
lives only on the wrapper, not on the titles inside it. So
`page_operands(canonical_node)` returns canonical values as
`list[RawTitle]`, and `query_exec.page_queries` keys them as `str`. A reader
of either sees a raw title where the value is the stored spelling, and a
raw one could be put in its place without a type error.

Found by the final review of pkm-hc95 branch 2 (triaged no-fix there: it
matches the existing wrapper design and is strictly stronger than the old
`str`).

Direction: make the node's title type say its kind, e.g. a node generic in
its title (`QueryNode[RawTitle]` from `parse_query`,
`QueryNode[CanonicalTitle]` from `parse_canonical_query`), or a separate
canonical node type replacing the NewType. `page_operands` and
`page_queries` then return/key `CanonicalTitle` for a canonical tree.
Type-only: no change to parsing, SQL or the `/api/query` response.

- [x] choose the shape (generic node vs separate type) and keep `plan_sql`
      accepting only a canonical tree
- [x] retype `page_operands`, `page_queries` and their callers
- [x] pyrefly probe: passing a parsed (raw) tree to `plan_sql`, or a raw
      title into a canonical node, is a type error


## Summary of Changes

QueryNode is now generic in its title (`class QueryNode[T: RawTitle]`, frozen so covariant). `parse_query` returns `QueryNode[RawTitle]`; `parse_canonical_query` returns `QueryNode[CanonicalTitle]`; `page_operands` is generic; `page_queries` keys `CanonicalTitle`; `plan_sql` takes `QueryNode[CanonicalTitle]` only. The CanonicalQueryNode NewType and its brand-registry entries, test helper `canonical_query_node_of`, tests and generated web registry rows are removed. The title field is renamed `operand` because the brand-name lint wants a field called `title` to be a brand, and here the brand is the type parameter. Probes in `server/tests/test_query_title_kinds.py`.
