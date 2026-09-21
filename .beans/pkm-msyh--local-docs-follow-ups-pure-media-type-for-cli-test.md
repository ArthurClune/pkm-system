---
# pkm-msyh
title: 'Local-docs follow-ups: pure media_type_for, CLI test fixture, viewer 503 test'
status: completed
type: task
priority: normal
created_at: 2026-09-21T15:00:20Z
updated_at: 2026-09-21T15:03:16Z
---

Follow-ups from pkm-g1ep (handoff 2026-09-21-local-docs-followups.md).

- [x] FCIS: replace mimetypes.guess_type in local_docs.media_type_for with an explicit extension table (pure, deterministic)
- [x] Extract local_pkm_client fixture in conftest.py; use it in both test_local_check_* CLI tests
- [x] PdfViewer.test.tsx: onLoadError({status: 503}) renders 'Not downloaded on the host.'
- [x] Verify: server pytest/ruff/pyrefly; web vitest/typecheck/lint/check:fcis

## Summary of Changes

- `local_docs.media_type_for` now reads from an explicit extension table (`_MEDIA_TYPES`) instead of `mimetypes.guess_type`, removing the lazy read of the host MIME registry from a Functional Core module; results are now identical on every machine. New test covers case-insensitivity, office formats, and the octet-stream default.
- New `local_pkm_client` fixture in conftest.py (built on `local_client`); both `test_local_check_*` CLI tests use it instead of hand-building a TestClient + PkmClient.
- PdfViewer.test.tsx: the react-pdf mock can fail with an arbitrary value (`failWith`); two new tests assert a 503 renders 'Not downloaded on the host.' and a 404 still renders "Couldn't render this PDF."
- Verified: server pytest 1714 passed at 97.38% coverage, ruff and pyrefly clean; web PdfViewer vitest 27 passed, typecheck, lint, check:fcis clean. No route or response changes, so no OpenAPI regeneration and no architecture-doc change.
