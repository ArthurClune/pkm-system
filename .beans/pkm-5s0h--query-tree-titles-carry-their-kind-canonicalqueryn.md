---
# pkm-5s0h
title: Query tree titles carry their kind (CanonicalQueryNode holds RawTitle)
status: todo
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

- [ ] choose the shape (generic node vs separate type) and keep `plan_sql`
      accepting only a canonical tree
- [ ] retype `page_operands`, `page_queries` and their callers
- [ ] pyrefly probe: passing a parsed (raw) tree to `plan_sql`, or a raw
      title into a canonical node, is a type error
