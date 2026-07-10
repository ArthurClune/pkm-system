---
# pkm-2939
title: 'Guardrail hardening: assert WAL in create_app; auto-discover read routes in drift test'
status: todo
type: task
priority: normal
created_at: 2026-07-10T12:21:55Z
updated_at: 2026-07-10T12:21:55Z
---

Follow-ups from the 2026-07-10 batch final-review triage — two convention-only guarantees worth making structural: (1) init_db()-before-serve is by convention; a future entrypoint or direct create_app(config) that serves DB routes would silently run non-WAL/non-migrated. Add a cheap assertion in create_app (e.g. journal_mode == 'wal' on a probe connection, or call init_db there) so it is un-forgettable; reconcile with the 7 TestClient call sites that don't use the with-form. (2) server/tests/test_openapi_sync.py's test_read_routes_declare_response_models hardcodes the 8 route→model pairs; auto-discover GET routes from the OpenAPI document instead so a new read route returning a bare dict fails the test.

## Checklist
- [ ] WAL/init assertion in create_app (or init_db call) + test
- [ ] Drift test auto-discovers read routes instead of hardcoded map
- [ ] Suites green
