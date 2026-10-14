---
# pkm-4g1a
title: 'Stale batch: a leading attribute naming a deleted page re-creates it'
status: in-progress
type: bug
priority: low
created_at: 2026-10-14T10:51:43Z
updated_at: 2026-10-14T12:22:09Z
---

Found in the pkm-ynze final review. In a stale batch (seen_seq before a page delete), links to the deleted title become plain text, but a leading attribute naming it survives: `X:: v` is left as is (unlink_title_refs never rewrites a leading attribute), and `[[X]]:: v` is unlinked into `X:: v`. Either way the block indexes an attribute ref to X and get_or_create re-creates the deleted page.

Rare (a stale offline edit typing the deleted page as an attribute name), but it breaks "only a device that has seen the delete can bring the page back".

Needs its own rule: park such text in the daily note instead of writing it, or write it with the attribute defused. Decide with Arthur.

## Todo

- [ ] Decide the rule with Arthur
- [ ] Reproduce in server/tests/test_stale_page_ops.py
- [ ] Implement and add to the Stale batches table in backend.md
