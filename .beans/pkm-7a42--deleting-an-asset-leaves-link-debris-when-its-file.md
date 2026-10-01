---
# pkm-7a42
title: Deleting an asset leaves link debris when its filename has spaces or parentheses
status: completed
type: bug
priority: normal
created_at: 2026-10-01T11:12:46Z
updated_at: 2026-10-01T11:19:42Z
---

`strip_asset_tokens` (server/src/pkm/assets_core.py) matches an asset URL as `/assets/<sha>/[^\s)}]*`. For a markdown link written by an upload, e.g. `[AI Day (Public).pdf](/assets/<sha>/AI Day (Public).pdf)`, the link pattern fails at the first space. The bare-URL pass then removes only `/assets/<sha>/AI`, leaving `[AI Day (Public).pdf]( Day (Public).pdf)` in the block. The `{{[[pdf]]: …}}` macro has the same problem.

Fix: find markdown link/image tokens with the same rule as the web scanner (`web/src/grammar/markdown.ts`: balanced brackets in the label, line-scoped balanced parens in the destination, fallback to the first `)`), and let the pdf macro body run to `}}`.

- [x] Failing tests: link and image with spaces and parens in the filename, pdf macro with spaces, both macro spellings
- [x] Scanner-based strip in assets_core.py
- [x] Server pytest + pyrefly + ruff green
- [x] Docs: troubleshooting row; check files-and-assets.md for the delete description

## Summary of Changes

- `strip_asset_tokens` (`server/src/pkm/assets_core.py`) now finds markdown link and image tokens with a port of the web's `scanMarkdownLinkAt` / `scanDestinationClose`: brackets nest in the label, and parens nest in the destination within the line, falling back to the first `)`. Only spans whose destination starts with `/assets/<sha>/` are removed.
- The pdf macro pass accepts both `{{[[pdf]]: …}}` and `{{pdf: …}}`, with the url running to `}}` on its line. The bare-URL pass is unchanged.
- Tests: 7 cases in `test_assets_core.py`, plus one end-to-end case in `test_asset_delete.py`.
- Docs: Delete bullet in `files-and-assets.md`; Backend row in `troubleshooting.md`.
