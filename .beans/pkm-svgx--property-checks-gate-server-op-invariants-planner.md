---
# pkm-svgx
title: 'Property checks: gate + server op invariants + Planner vs server'
status: in-progress
type: feature
priority: normal
created_at: 2026-10-02T10:57:25Z
updated_at: 2026-10-02T10:57:35Z
parent: pkm-nws9
---

proptest/check.sh gate (pytest marker proptest, excluded from pytest -q; Hypothesis merge profile), stateful server op invariants via /api/ops, and plan_batch -> apply_batch vs a position reference model. Spec: docs/superpowers/specs/2026-10-02-property-checks-server-design.md
