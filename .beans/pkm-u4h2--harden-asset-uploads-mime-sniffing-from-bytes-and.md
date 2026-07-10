---
# pkm-u4h2
title: 'Harden asset uploads: MIME sniffing from bytes and streaming to disk'
status: todo
type: task
priority: low
created_at: 2026-07-10T10:57:34Z
updated_at: 2026-07-10T10:57:50Z
parent: pkm-m309
---

Review residual threat-model notes (security section). Two hardening items for the upload endpoint, acceptable today under the Tailscale-only model but worth doing: (1) it trusts the client-declared MIME type — the Content-Disposition allowlist plus nosniff limits execution risk, but detecting MIME from file bytes would make stored metadata and the inline/download decision more trustworthy; (2) it reads up to 150 MiB into memory at once — streaming to a bounded temporary file would be more resilient.

## Checklist
- [ ] Detect MIME type from content bytes and reconcile with the client-declared type
- [ ] Stream uploads to a bounded temp file instead of reading up to 150 MiB into memory
- [ ] Tests for spoofed MIME declarations and large-upload behavior
