---
# pkm-h1em
title: MCP read tools must not follow ../ in titles to other routes
status: todo
type: bug
priority: low
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T10:56:19Z
parent: pkm-mfd0
---

Review finding (Low): PkmClient.get_page quotes the title with safe='/', and httpx2 normalises dot segments, so auto-allowed get_page/backlinks with '../sync/snapshot' reach other GET routes without approval. Nothing was disclosed, but expensive work (snapshot, export.zip, GoodLinks fetch) runs unapproved.

- [ ] Red test first, from the review probe: sec-assistant/probe_upload.py (read-tool path traversal section) and probe_preview.py. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] Encode dot segments (or the whole title) so the request stays under /api/page/
- [ ] Test with ../ titles against a MockTransport
