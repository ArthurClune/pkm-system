---
# pkm-d8vp
title: 'upload_asset: show and constrain the resolved host path'
status: in-progress
type: task
priority: normal
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-24T17:57:11Z
parent: pkm-mfd0
---

Review finding (Low): an approved upload_asset reads any service-account-readable file with an allowed extension, follows symlinks, and resolves relative paths against the server cwd (app/server in production), so ../../data/config.json is the server's secret config. The card shows the path as emitted.

- [ ] Red test first, from the review probe: sec-assistant/probe_upload.py. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [x] Decide containment (Arthur, 2026-10-24): remove upload_asset from the in-app assistant entirely; keep it in pkm-mcp
- [ ] Assistant: drop upload_asset from WRITE_TOOLS / WRITE_PREVIEW_FIELDS / the system prompt's write-verb list (pkm.assistant.policy), so the assistant's MCP allow-list never offers it; a test that the assistant's tool list excludes it and that a call to it is denied
- [ ] Docs: the assistant section says the assistant cannot read host files, and why

## Decision (Arthur, 2026-10-24)

Uploads never happen from the assistant: it has no way to obtain files. So the assistant loses the tool rather than gaining a containment root. pkm-mcp keeps upload_asset unchanged: there it runs as the user in their own agent session (path relative to that session's cwd), so reading the user's files is the point and no privilege boundary is crossed. The resolved-path card and relative-path rules are moot once the assistant cannot call it. The red test still comes from sec-assistant/probe_upload.py: through the assistant, ../../data/config.json must be refused (tool not offered/denied).
