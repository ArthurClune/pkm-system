---
# pkm-2xh2
title: Turn data/ into a small committed test dataset
status: todo
type: task
priority: low
created_at: 2026-07-17T19:07:25Z
updated_at: 2026-07-17T19:07:25Z
---

data/ is currently a gitignored 15MB copy of the full Roam import (July 8-9: 4,313 pages, 52,695 blocks, 1,647 assets in the content-addressed store) that dev servers/importers use as the default --data-dir. (sample-data/ in .gitignore was the original Roam .edn export source, not a test set.)

Replace it with a real, small test dataset:
- Strip all assets (or keep 1-2 tiny ones to exercise the asset store/upload paths)
- Reduce the DB to a curated set of sample pages that exercise features: journal/daily pages, wikilinks + backlinks, block refs, embeds, tables, code blocks + fences, mermaid, $$...$$ math (inline + display + invalid-TeX fallback), PDFs macro, TODOs, nested/numbered lists, page with unicode/emoji names, collapsed blocks
- Make it reproducible: ideally a script that generates the dataset (or prunes a full DB), rather than a hand-frozen binary sqlite file
- Consider committing it (un-gitignore) so fresh checkouts get a working dev instance without a private Roam export; check nothing personal leaks into the sample pages
- Keep the e2e temp-DB approach as-is (server/tests/e2e_serve.py creates fresh DBs); this is for interactive dev use
