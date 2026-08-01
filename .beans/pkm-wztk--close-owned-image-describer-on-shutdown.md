---
# pkm-wztk
title: Close owned image describer on shutdown
status: todo
type: bug
priority: low
created_at: 2026-08-01T19:23:16Z
updated_at: 2026-08-01T19:23:16Z
parent: pkm-ulae
---

## Context

pkm-ulae finding 28: DescribeService owns the production OpenAIDescriber but shutdown only cancels the worker, leaking its persistent async HTTP client.

## Checklist

- [ ] Add lifecycle and application teardown regression tests
- [ ] Define ImageDescriber close and service ownership semantics
- [ ] Close the describer exactly once after worker shutdown
- [ ] Keep application teardown failure-safe across owned services
- [ ] Run focused tests, pyrefly, and ruff
- [ ] Commit implementation and bean summary
