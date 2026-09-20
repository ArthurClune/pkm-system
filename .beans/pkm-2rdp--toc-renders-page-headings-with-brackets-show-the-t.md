---
# pkm-2rdp
title: toc renders [[Page]] headings with brackets; show the title instead
status: completed
type: bug
priority: normal
created_at: 2026-09-20T20:16:36Z
updated_at: 2026-09-20T20:18:16Z
---

A heading whose text is a page ref, e.g. '## [[Mathematics]]', showed in the {{toc}} block as the literal '[[Mathematics]]': tocEntries stored the raw block text and TableOfContents printed it verbatim. Seen on page 'AI in Research'.

- [x] failing unit test in tocEntries.test.ts
- [x] flatten heading text via tokenizeBlock in tocEntries (page-ref -> title, tag -> #title, emphasis unwrapped)
- [x] web verification (typecheck, unit)

## Summary of Changes

- tocEntries.ts gains headingText(): runs the heading through the shared tokenizeBlock and flattens every segment to prose (page refs -> title, hashtags -> #title, emphasis unwrapped, markdown links -> label, inline code -> code). Block-level segments contribute nothing.
- TocEntry.text now carries that plain text; TableOfContents is unchanged.
- Replaced the unit test that pinned raw text with two covering a bare [[ref]] heading and a mixed heading.
