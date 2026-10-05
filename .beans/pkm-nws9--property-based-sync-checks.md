---
# pkm-nws9
title: Property-based sync checks
status: completed
type: epic
priority: normal
created_at: 2026-10-02T10:57:18Z
updated_at: 2026-10-05T19:37:01Z
---

A heavyweight property-based test gate, run before merge like perf/check.sh (proptest/check.sh), never on every commit. Budget ~2-5 min per suite: each sub-project's suite brings its own budget, so the gate's total grows as suites are added (Arthur, 2026-10-03). Four sub-projects, each with its own spec -> plan -> build: (1) gate + server op invariants + Planner-vs-server; (2) sync protocol harness (offline edits, lost acks, replays, reconnects, recovery, multiple clients converge); (3) client/server op-semantics divergence; (4) outline edit commands. Policy: every failure the gate finds is fixed with the shrunk case as an ordinary unit test in the normal suite.

## Summary of Changes

All four sub-projects shipped; `proptest/check.sh` runs before merge, never per commit, and stays out of `pytest -q` and `pnpm verify`.

| Sub-project | Bean | Suite |
|---|---|---|
| Gate, server op invariants, Planner vs server | pkm-svgx | server (Hypothesis, ~3 min) |
| Sync protocol harness | pkm-yxcs (widened by pkm-5k8q, pkm-dbr1) | web `props/sync` (~170 s) |
| Outline edit commands | pkm-f7zv | web `props/outline` (~50 s) |
| Client/server op divergence | pkm-j3ui | web `props/ops` (~60 s) |

Each suite has teeth (mutants it must catch); the web side runs in about 5 minutes. Findings were fixed with the shrunk case as a unit test, as the policy required: pkm-jarz, pkm-hb4x, pkm-91ux, pkm-f170, pkm-d3qh, pkm-undg, pkm-sj5l, pkm-pp7q, pkm-y0kq, pkm-xtqz, pkm-wj9b, pkm-hz8w, pkm-dbr1, and the replay rebase (the effect ledger replaced by a pre-image replay log). Docs: docs/architecture/property-checks.md. Follow-up outside the epic: pkm-p5t6.
