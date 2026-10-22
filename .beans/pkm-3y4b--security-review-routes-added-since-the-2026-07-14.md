---
# pkm-3y4b
title: 'Security review: routes added since the 2026-07-14 review'
status: todo
type: task
created_at: 2026-10-22T21:23:00Z
updated_at: 2026-10-22T21:23:00Z
---

The last security review was 2026-07-14 (docs/SECURITY.md). Since then routes arrived that serve host files and third-party HTML, plus others that reach beyond the graph. Review them against docs/SECURITY.md's threat model and update that doc.

Scope:
- [ ] /api/local/{path}, /api/local/check, /api/local-index: containment (clean_relative, is_within, wholepath decoding, symlinks, .icloud stubs), inline vs attachment disposition, error-page escaping
- [ ] GET /api/goodlinks/{link_id}: sanitize_article allowlist (nh3) and the sandboxed srcdoc iframe; /api/goodlinks/resolve and the loopback bearer gateway
- [ ] Image descriptions: what leaves the host to OpenAI and when it is on
- [ ] POST /api/client/diagnostics: body size and log injection
- [ ] Assistant: write-gating preview (ops_preview, _MAX_PREVIEW_VALUE_CHARS), subprocess token, built-in tools disabled
- [ ] Anonymous route-table walk (a probe, or the contract test from SECURITY.md hardening priority 2)
- [ ] Update docs/SECURITY.md: last-reviewed date and findings
