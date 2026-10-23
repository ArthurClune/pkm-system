---
# pkm-3y4b
title: 'Security review: routes added since the 2026-07-14 review'
status: completed
type: task
priority: normal
created_at: 2026-10-22T21:23:00Z
updated_at: 2026-10-23T10:25:32Z
---

The last security review was 2026-07-14 (docs/SECURITY.md). Since then routes arrived that serve host files and third-party HTML, plus others that reach beyond the graph. Review them against docs/SECURITY.md's threat model and update that doc.

Scope:
- [x] /api/local/{path}, /api/local/check, /api/local-index: containment (clean_relative, is_within, wholepath decoding, symlinks, .icloud stubs), inline vs attachment disposition, error-page escaping
- [x] GET /api/goodlinks/{link_id}: sanitize_article allowlist (nh3) and the sandboxed srcdoc iframe; /api/goodlinks/resolve and the loopback bearer gateway
- [x] Image descriptions: what leaves the host to OpenAI and when it is on
- [x] POST /api/client/diagnostics: body size and log injection
- [x] Assistant: write-gating preview (ops_preview, _MAX_PREVIEW_VALUE_CHARS), subprocess token, built-in tools disabled
- [x] Anonymous route-table walk (a probe, or the contract test from SECURITY.md hardening priority 2)
- [x] Update docs/SECURITY.md: last-reviewed date and findings

## Summary of Changes

Review against 5ce279af recorded in docs/SECURITY.md (2026-10-23). No fixes. Confirmed outbound image-request channel in assistant rendering (successful model injection remains a prerequisite); batch preview target omission; anonymous access-log control injection; unbounded authenticated diagnostics logging. Local containment and anonymous route-table checks passed. GoodLinks URL-parser observation and original-image metadata disclosure documented. Focused suites passed; no production/provider calls. Review-only changes are on review/security-3y4b.
