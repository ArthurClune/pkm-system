---
# pkm-ub5s
title: Deferred minors from the medium-priority frontend reviews
status: todo
type: task
priority: low
created_at: 2026-08-18T18:58:34Z
updated_at: 2026-08-18T18:58:34Z
parent: pkm-wvvu
---

Review-deferred minor findings from pkm-3lqg / pkm-nqve / pkm-d5re / pkm-2i6a / pkm-jk21 / pkm-nvxh (task reviews under the epic's 2026-08-17 sources; the final whole-branch review triaged these as follow-up material — none block anything).

## Checklist

Correctness-adjacent polish:
- [ ] tree.test.ts equivalence table: add the missing set_view_type no-op variant (a block whose view_type already matches the op) — the one untested no-op branch at tree.ts:211
- [ ] docs/architecture/frontend.md change-signal paragraph overstates identity: a no-op local-ops transition still returns a new state object (it records the write ticket); only revision is unmoved, and revision is the publish gate. Add the qualifier.
- [ ] BacklinksSection.tsx:95 Infinity sentinel is safe only while refresh's first nextLimit call is unconditional — add the comment saying so
- [ ] BacklinksSection.tsx:24 single `loading` flag is shared by loadMore and loadAll; with both in flight the first settle re-enables buttons early (cosmetic — walks are idempotent). Comment or per-caller flag.
- [ ] replicaSync.ts flushLease: make the "blocking" policy an explicit branch with a `const exhaustive: never` check (house style per queueState.ts:120) instead of untagged fall-through
- [ ] replicaSync.ts "blocking" flush policy discards the original flush error — a transport failure and a server rejection are indistinguishable behind one "reset blocked" message; preserve/attach the cause
- [ ] useOutline refetch: add a direct test pinning "404 on the cross-page-move catch-up read leaves a daily empty rather than rejecting" (the one judgement call in pkm-jk21's diff)

Test hygiene:
- [ ] tooling/lintConfig.test.ts needs an explicit timeout — its ESLint spawn takes ~2s under coverage against the 5s default and flaked repeatedly during parallel verify runs

If Popover.tsx's remeasure prop is ever touched: replace the comment-only fixed-length contract with a shallow-compare against a ref inside the effect (length-agnostic, and the eslint-disable goes away).
