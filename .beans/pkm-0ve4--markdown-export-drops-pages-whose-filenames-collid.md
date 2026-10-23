---
# pkm-0ve4
title: Markdown export drops pages whose filenames collide on APFS
status: todo
type: bug
priority: high
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T11:36:48Z
parent: pkm-mfd0
---

Review finding (Low, integrity of the nightly markdown backup): page_filename dedupes with str.lower(), but APFS also folds Unicode normalization and full case folding. café NFC/NFD, Straße/STRASSE, ς/σ, ﬀ/ff overwrite each other silently; export_graph still counts both.

- [ ] Red test first, from the review probe: sec-exports/p2_zip.py (collision half). Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] Dedupe key matches APFS: NFD/NFC-normalise and casefold
- [ ] Same for the selected-asset zip arcnames
- [ ] Test that every page in the DB appears in the archive
- [x] Check whether existing backup git history already lost pages

## Backup history check (2026-10-23)

Every retained sqlite snapshot (monthly 07-31, 08-31, 09-30, then daily
10-07..10-21) plus today's prod DB: no two titles whose export filenames
collide under NFD + casefold but differ under str.lower(). The only
collisions are plain case ("Conflict"/"conflict", "Local Copy"/"Local copy"),
which the current lower() dedupe already handles ("conflict (2).md",
"Local copy (2).md" in the export). So the backup has lost no pages to this
finding in the retained history; gaps between monthly snapshots are unchecked.
