---
# pkm-6fqw
title: Escape control characters in access-log lines and bound diagnostics bodies
status: completed
type: bug
priority: normal
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-11-16T10:20:47Z
parent: pkm-mfd0
---

Review findings (Low): RequestLogMiddleware interpolates the decoded path into request_line unescaped, so an anonymous request can forge log lines and ANSI escapes; POST /api/client/diagnostics has no body or field size bound and logs the whole payload.

- [x] Red test first, reproducing the review's finding.
- [x] request_line escapes control characters in the path
- [x] Diagnostics body and logged size bounded (413 or truncation with a marker)
- [x] Tests for both

## Summary of Changes

`logfmt.escape_controls` escapes C0/C1 controls, DEL and backslash in every `request_line` field. `client_diagnostics` still answers 200 but cuts the logged JSON at `_MAX_DIAGNOSTICS_LOG_CHARS` (64 KiB) with a `…[truncated: N chars]` marker. Docs and troubleshooting rows added; openapi regenerated.
