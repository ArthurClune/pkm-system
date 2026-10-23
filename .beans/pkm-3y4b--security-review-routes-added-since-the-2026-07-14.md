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
- [x] Write a separate review report (docs/SECURITY.md is left unchanged until the fixes land: pkm-e95y)

Second pass (the first ran out of quota before these new-since-review surfaces):
- [x] Exports and asset routes: /api/export.zip, /api/export/page/{title}, POST /api/assets/export.zip, DELETE /api/assets/{sha256}, /api/assets/search; SPA catch-all on wholepath
- [x] Page and graph routes on wholepath titles: page get/delete/rename, delete-preview, block, backlinks, changed, todos, current-work; SQL construction
- [x] Assistant conversation routes and approval binding; pkm-mcp host filesystem and network reach (upload_asset)
- [x] Auth/WS changes since the last review (login throttle source key), CSRF site boundary, response headers, service-worker/offline storage, dependency advisories
- [x] Fold second-pass findings into the report; actions as epic pkm-mfd0

## Summary of Changes

Review against 5ce279af recorded in docs/security-review-2026-10-23.md. No fixes. Confirmed outbound image-request channel in assistant rendering (successful model injection remains a prerequisite); batch preview target omission; anonymous access-log control injection; unbounded authenticated diagnostics logging. Local containment and anonymous route-table checks passed. GoodLinks URL-parser observation and original-image metadata disclosure documented. Focused suites passed; no production/provider calls. Review-only changes are on review/security-3y4b.

Second pass (same report, `## Second pass`): the first pass's checklist missed exports, asset delete/search, wholepath page routes, approval binding, pkm-mcp, auth/WS changes, the service worker and dependencies. New Mediums: the tailnet is one site (ts.net is a public suffix) and /api/ws checks no Origin while streaming op text; the approval card collapses at 300 characters with model-ordered arguments; a string-encoded batch.commands bypasses the per-op listing. Lows: upload_asset relative paths resolve against app/server (../../data/config.json); control-whitespace title folding; APFS name collisions drop pages from the markdown export/backup; login burst and X-Forwarded-For keying, pre-auth bodies, non-ASCII cookie 500; a table of 500s and unbounded work; MCP read tools following ../ in titles. No fixes. docs/SECURITY.md is unchanged on this branch; the corrections it needs are listed in pkm-e95y, to be made once the fixes in epic pkm-mfd0 land.
