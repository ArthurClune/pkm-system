---
# pkm-49gk
title: rename._rewrite_range recurses once per bracket nesting level
status: todo
type: bug
priority: deferred
created_at: 2026-10-05T20:48:03Z
updated_at: 2026-10-05T20:48:03Z
---

server/src/pkm/rename.py _rewrite_range recurses per nesting level of [[...]] runs, so rewrite_title_refs on block text nested thousands deep would raise RecursionError (Python's limit is 1000). refs.bracket_spans and iter_bracket_spans are iterative since the ref-pairing fix, so rename is the remaining recursive walk over a bracket tree. Pre-existing; no real block nests anywhere near that deep. Fix: walk the span tree with an explicit stack, keeping the rule that a replaced title takes its whole [[..]] run; add a deep-nesting rename test beside the refs depth test.
