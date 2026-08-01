---
# pkm-wztk
title: Close owned image describer on shutdown
status: completed
type: bug
priority: low
created_at: 2026-08-01T19:23:16Z
updated_at: 2026-08-01T19:30:59Z
parent: pkm-ulae
---

## Context

pkm-ulae finding 28: DescribeService owns the production OpenAIDescriber but shutdown only cancels the worker, leaking its persistent async HTTP client.

## Checklist

- [x] Add lifecycle and application teardown regression tests
- [x] Define ImageDescriber close and service ownership semantics
- [x] Close the describer exactly once after worker shutdown
- [x] Keep application teardown failure-safe across owned services
- [x] Run focused tests, pyrefly, and ruff
- [x] Commit implementation and bean summary

## Summary of Changes

Made `DescribeService` the explicit owner of its `ImageDescriber`, added idempotent worker-first shutdown and HTTP-client closure, and made app teardown attempt assistant cleanup even when describe cleanup fails. Added service, transport, and lifespan regressions.
