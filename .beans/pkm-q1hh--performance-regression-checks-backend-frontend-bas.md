---
# pkm-q1hh
title: Performance regression checks (backend + frontend baselines)
status: completed
type: feature
priority: normal
created_at: 2026-09-26T10:42:33Z
updated_at: 2026-09-26T14:17:49Z
---

Performance regression gate: `perf/check.sh [auto|backend|frontend] [--bootstrap] [--rebaseline] [--runs N]`.

- Spec: docs/superpowers/specs/2026-09-26-perf-regression-checks-design.md
- Plan: docs/superpowers/plans/2026-09-26-perf-regression-checks.md
- Baselines: perf/baseline-backend.json, perf/baseline-frontend.json
- Follow-ups: pkm-ur2n (app double-pulls a sync window after a save), pkm-elyy (fast-typing S variant for the search debounce), pkm-lace (K/S React quiet wait)

## Summary of Changes
Synthetic prod-scale fixture (server/tooling/perfcheck) applied through the real ops path; in-process backend check (statements, nested statements, VM steps, bytes, full scans, median timings) under a frozen clock; headless Playwright frontend check (web/tooling/perf/check.mjs + harness.mjs) on port 8977 under a fake clock; compare core with exact/band/timing classes, ratchet on improvement, confirmation by re-run then merge-base run. SPA emits performance.mark("pkm:replica-ready"). Wired into AGENTS.md, /verify, perf README and architecture docs.
