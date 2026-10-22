---
# pkm-zutb
title: Rename rewrites a link whose brackets hold a code span and loses the span's text
status: in-progress
type: bug
priority: normal
created_at: 2026-10-22T09:08:05Z
updated_at: 2026-10-22T09:49:31Z
---

Found while fixing the importer (pkm-lvyl). When a code span sits between a link's brackets, `strip_code` blanks it, so `bracket_spans` reads `[[a`b]] and #[[x`]]` as one link titled `a` plus padding. Under plain-space canonicalisation that spelling canonicalises to `a`. A rename of page `a` rewrites the whole span, and the text inside the code span is lost:

    rewrite_title_refs_map('see [[a`b]] and #[[x`]] end', {'a': 'z'},
        normalize=spelled_or_canonical(plain-space canonicalize_title, ...))
    -> 'see [[z]] end'

The importer's title rewrite hits the same thing, with the padded key extract reports. The original Roam export holds no such block. Page delete (`unlink.py`) splices over the same spans, so check it too.

The rename property (test_rename_props.py) checks "text outside the rewritten refs is byte-identical", but this loss is *inside* a rewritten span, so the property passes.

## Ruling (Arthur, 2026-10-22)

A backtick anywhere inside a link, tag or attribute title as written (a code span, or a lone backtick) means it is no ref at all: plain text, like `[[.]]`. Both parsers, the renderer, rename, delete and import agree. This replaces the save refusal pkm-0nzy installed for a backtick ref; page titles with a backtick stay refused. A copy of the prod DB holds no block with a backtick ref or a code span inside link brackets, so no migration.

## Checklist

- [x] Reproduce through the rename route (and page delete) under the plain-space flag
- [x] Server: one predicate; extract, rename, unlink and every other span consumer skip such a span
- [x] Web: scan.ts (extractRefs and the renderer) and any local rewrite agree; ref_grammar.json rows both parsers replay
- [x] Rename property draws code spans and lone backticks inside brackets; mutant
- [ ] Docs: backend.md Refused titles, importer table, troubleshooting row
