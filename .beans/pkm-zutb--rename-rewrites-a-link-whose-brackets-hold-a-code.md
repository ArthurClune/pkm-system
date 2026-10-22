---
# pkm-zutb
title: Rename rewrites a link whose brackets hold a code span and loses the span's text
status: todo
type: bug
priority: normal
created_at: 2026-10-22T09:08:05Z
updated_at: 2026-10-22T09:08:05Z
---

Found while fixing the importer (pkm-lvyl). When a code span sits between a link's brackets, `strip_code` blanks it, so `bracket_spans` reads `[[a`b]] and #[[x`]]` as one link titled `a` plus padding. Under plain-space canonicalisation that spelling canonicalises to `a`. A rename of page `a` rewrites the whole span, and the text inside the code span is lost:

    rewrite_title_refs_map('see [[a`b]] and #[[x`]] end', {'a': 'z'},
        normalize=spelled_or_canonical(plain-space canonicalize_title, ...))
    -> 'see [[z]] end'

The importer's title rewrite hits the same thing, with the padded key extract reports. The original Roam export holds no such block. Page delete (`unlink.py`) splices over the same spans, so check it too.

The rename property (test_rename_props.py) checks "text outside the rewritten refs is byte-identical", but this loss is *inside* a rewritten span, so the property passes.

## Checklist

- [ ] Reproduce through the rename route (and page delete) under the plain-space flag
- [ ] Decide the rule: a link whose bracket span holds masked code is not a ref, or the rewrite keeps the masked text
- [ ] Fix; add a property draw for code spans between brackets; mutant
