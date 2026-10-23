---
# pkm-6fqw
title: Escape control characters in access-log lines and bound diagnostics bodies
status: todo
type: bug
priority: normal
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T10:56:19Z
parent: pkm-mfd0
---

Review findings (Low): RequestLogMiddleware interpolates the decoded path into request_line unescaped, so an anonymous request can forge log lines and ANSI escapes; POST /api/client/diagnostics has no body or field size bound and logs the whole payload.

- [ ] Red test first, from the review probe: the first-pass probes were not kept; rebuild from the review doc's reproductions. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] request_line escapes control characters in the path
- [ ] Diagnostics body and logged size bounded (413 or truncation with a marker)
- [ ] Tests for both
