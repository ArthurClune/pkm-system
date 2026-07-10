---
# pkm-u4h2
title: 'Harden asset uploads: MIME sniffing from bytes and streaming to disk'
status: completed
type: task
priority: low
created_at: 2026-07-10T10:57:34Z
updated_at: 2026-07-10T11:38:44Z
parent: pkm-m309
---

Review residual threat-model notes (security section). Two hardening items for the upload endpoint, acceptable today under the Tailscale-only model but worth doing: (1) it trusts the client-declared MIME type — the Content-Disposition allowlist plus nosniff limits execution risk, but detecting MIME from file bytes would make stored metadata and the inline/download decision more trustworthy; (2) it reads up to 150 MiB into memory at once — streaming to a bounded temporary file would be more resilient.

## Checklist
- [x] Detect MIME type from content bytes and reconcile with the client-declared type
- [x] Stream uploads to a bounded temp file instead of reading up to 150 MiB into memory
- [x] Tests for spoofed MIME declarations and large-upload behavior

## Summary of Changes

- New pure magic-byte sniffer (server/src/pkm/server/mime_sniff.py, stdlib only): PNG/JPEG/GIF/WEBP/PDF/SVG; sniffed type wins over the client-declared one when confident.
- Upload route now streams in 1 MiB chunks to a temp file in the assets area (sha256 while streaming, cap enforced mid-stream, atomic os.replace), sniffing from the first chunk; temp file cleaned on every error path.
- SVG still forced to download; sniffer output domain is a subset of the upload allowlist. 269 server tests pass, pyrefly clean. Merged to main (--no-ff).
- Deferred minors (final-review triage): no HTTP-level multi-chunk big-upload test; HEIC not sniffable (falls back to declared type).
