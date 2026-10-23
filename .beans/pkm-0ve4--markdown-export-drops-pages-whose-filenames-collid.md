---
# pkm-0ve4
title: Markdown export drops pages whose filenames collide on APFS
status: todo
type: bug
priority: high
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T10:56:19Z
parent: pkm-mfd0
---

Review finding (Low, integrity of the nightly markdown backup): page_filename dedupes with str.lower(), but APFS also folds Unicode normalization and full case folding. café NFC/NFD, Straße/STRASSE, ς/σ, ﬀ/ff overwrite each other silently; export_graph still counts both.

- [ ] Red test first, from the review probe: sec-exports/p2_zip.py (collision half). Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] Dedupe key matches APFS: NFD/NFC-normalise and casefold
- [ ] Same for the selected-asset zip arcnames
- [ ] Test that every page in the DB appears in the archive
- [ ] Check whether existing backup git history already lost pages
