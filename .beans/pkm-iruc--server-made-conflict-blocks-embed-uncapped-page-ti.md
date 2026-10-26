---
# pkm-iruc
title: Server-made conflict blocks embed uncapped page titles
status: completed
type: bug
priority: low
created_at: 2026-10-25T02:14:31Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

From the pkm-gc3n/bppf Task 3 review (2026-10-25). Conflict blocks the server makes ([[conflict]] [[Page]] headers, copied legacy text) are not judged; headers embed page titles, which have no length cap, and copies carry legacy over-limit text. Judge them with the rewrite rule or cap title length.

- [x] Decide: title length cap vs judging server-made conflict text
- [x] Tests
- [x] troubleshooting.md row

## Summary of Changes

- Behaviour: server-made conflict headers and notes can no longer exceed a text limit: each builder in conflict_notes.py goes through `_fitted`, which falls back to the label "(page title too long)" when the text with the real title or `page_title` hint is refused. Page titles themselves are now also capped at 1,000 characters (pkm-ax2j), so the decision was both: judge the server-made text and cap titles. Copies of stored legacy rows stay level with the stored rows.
- Commit: e3f6ed7d; 04596723 keeps "(page not found)" when a missing page's name falls back. Troubleshooting row under Writes, conflicts and races; backend.md Conflicts header table.
- Notes: a title nesting `[[` past the nesting cap needed no fallback (it never reads back as one link and is rendered as code or "(page unknown)"), so the nested case asserts only that the text fits. No ruling needed. Follow-ups: none.
