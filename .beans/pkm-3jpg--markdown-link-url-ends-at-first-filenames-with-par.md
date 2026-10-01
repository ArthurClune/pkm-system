---
# pkm-3jpg
title: Markdown link URL ends at first ')' — filenames with parentheses lose PDF preview
status: completed
type: bug
priority: normal
created_at: 2026-10-01T11:02:33Z
updated_at: 2026-10-01T11:10:28Z
---

An uploaded asset whose filename contains parentheses, e.g. `[x.pdf](/assets/<sha>/AI Day (Public) - Schedule.pdf)`, renders as a plain link with ` - Schedule.pdf)` left over as text, and no PDF preview. The link still opens because the server looks the asset up by sha alone.

Cause: `scanMarkdownLinkAt` (web/src/grammar/markdown.ts) ends the destination at the first `)`, so the href is cut off at `(Public` and `isPdfHref` no longer sees `.pdf`.

Fix: count balanced parentheses inside the destination, as CommonMark does, so existing blocks render correctly without being rewritten.

- [x] Failing tests for balanced parens in the destination (scanner and tokenizer/PDF path)
- [x] Balanced-paren scan in scanMarkdownLinkAt, falling back to the first ')' when the parens never balance
- [x] Web unit tests + typecheck green
- [x] troubleshooting.md row; check frontend-rendering docs for the link grammar

## Summary of Changes

- `scanDestinationClose` in `web/src/grammar/markdown.ts` nests parentheses inside a link destination, line-scoped, and falls back to the first `)` when they never balance on the line, so unbalanced text parses as before.
- New `web/src/grammar/markdown.test.ts`; `tokenize.test.ts` pins the reported uploaded-PDF block as one `link` segment with the full href.
- `frontend-rendering.md § The pipeline` states the destination rule; `troubleshooting.md` has a Rendering row.
- Follow-up candidate (not done): `strip_asset_tokens` in `server/src/pkm/assets_core.py` matches `[^\s)}]*` for the filename, so it doesn't strip markdown links to assets whose filenames contain spaces or parens.
