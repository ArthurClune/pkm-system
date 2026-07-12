---
# pkm-89yk
title: Audit tests for false positives and coverage gaps
status: completed
type: task
priority: normal
created_at: 2026-07-12T17:49:51Z
updated_at: 2026-07-12T17:55:30Z
---

Review backend, frontend, and E2E test suites for shims that do not exercise production behavior, weak assertions, excessive mocking, missing coverage instrumentation, and material untested paths.

- [x] Inventory test configuration and execution
- [x] Inspect suspicious tests against production code
- [x] Run suites and collect available coverage evidence
- [x] Report prioritized findings with file and line references

## Summary of Changes

Audited pytest, Vitest, and Playwright suites; measured backend and frontend branch/line coverage transiently without changing dependency manifests; traced a failing E2E test to stale zero-delay bracket input after auto-pairing; identified missing coverage gates, handler-wiring gaps, and low-value smoke coverage. No production or test code was modified.
