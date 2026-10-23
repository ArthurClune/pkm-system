---
# pkm-d8vp
title: 'upload_asset: show and constrain the resolved host path'
status: todo
type: task
priority: normal
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T10:56:19Z
parent: pkm-mfd0
---

Review finding (Low): an approved upload_asset reads any service-account-readable file with an allowed extension, follows symlinks, and resolves relative paths against the server cwd (app/server in production), so ../../data/config.json is the server's secret config. The card shows the path as emitted.

- [ ] Red test first, from the review probe: sec-assistant/probe_upload.py. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] Decide containment: refuse paths outside local_docs_root (and the CLI's own use case?) or refuse the data dir explicitly
- [ ] Card shows the resolved absolute path (and symlink target)
- [ ] Refuse relative paths in the MCP tool, or resolve them against a documented root
