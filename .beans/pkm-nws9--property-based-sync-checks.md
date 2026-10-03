---
# pkm-nws9
title: Property-based sync checks
status: in-progress
type: epic
priority: normal
created_at: 2026-10-02T10:57:18Z
updated_at: 2026-10-03T09:17:05Z
---

A heavyweight property-based test gate, run before merge like perf/check.sh (proptest/check.sh), never on every commit. Budget ~2-5 min per suite: each sub-project's suite brings its own budget, so the gate's total grows as suites are added (Arthur, 2026-10-03). Four sub-projects, each with its own spec -> plan -> build: (1) gate + server op invariants + Planner-vs-server; (2) sync protocol harness (offline edits, lost acks, replays, reconnects, recovery, multiple clients converge); (3) client/server op-semantics divergence; (4) outline edit commands. Policy: every failure the gate finds is fixed with the shrunk case as an ordinary unit test in the normal suite.
