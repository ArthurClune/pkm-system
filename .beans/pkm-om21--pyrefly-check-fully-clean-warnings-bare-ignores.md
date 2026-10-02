---
# pkm-om21
title: pyrefly check fully clean (warnings + bare ignores)
status: completed
type: task
priority: normal
created_at: 2026-10-02T10:03:28Z
updated_at: 2026-10-02T10:05:44Z
---

pyrefly hides warnings by default; 7 were showing at --min-severity info, and two bare `# pyrefly: ignore` comments suppressed every error on their lines.

- [x] Fix: contextmanager return type Iterator -> Generator (tooling/perfcheck/build.py)
- [x] Fix: drop redundant str() on ErrorDetails.msg (test_data/core.py)
- [x] Fix: rmtree fakes in test_export_writer.py take the signature writer.py actually calls
- [x] Suppress (with code + reason): 3 unnecessary-comparison false positives from stale narrowing
- [x] Narrow bare ignores in goodlinks.py and tempfile_response.py to specific codes with reasons
- [x] Verify: pyrefly at --min-severity info clean, pytest, ruff

## Summary of Changes

`pyrefly check --min-severity info` now reports 0 diagnostics. The only remaining suppressions carry an error code and a reason.

- Fixed: `cache_lock` returns `Generator[None, None, None]`; the redundant `str()` on pydantic's `ErrorDetails.msg` is gone; the `rmtree` fakes in `test_export_writer.py` take `(path, ignore_errors=False)`, which is what `writer.py` actually calls, so they no longer match the deprecated `onerror` overload.
- Suppressed with `ignore[unnecessary-comparison]` and a reason (3 tests): pyrefly keeps a narrowing from an earlier assert past the call that changes the value (lifespan shutdown, `close()`, a `nonlocal` assignment).
- Bare ignores: the `import nh3` one was stale (nh3 ships `py.typed`), so it was removed. The one on `CleanupFileResponse.__init__` was hiding 8 `bad-argument-type` errors from forwarding `*args: object`. The constructor now declares `path`, `media_type`, `filename` and `cleanup`, which are the parameters its callers pass.
