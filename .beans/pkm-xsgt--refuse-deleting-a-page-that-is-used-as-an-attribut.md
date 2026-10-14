---
# pkm-xsgt
title: Refuse deleting a page that is used as an attribute
status: completed
type: feature
priority: normal
created_at: 2026-10-13T21:10:21Z
updated_at: 2026-10-14T07:53:11Z
---

Follow-up to pkm-wlkh (page delete unlinks references). Deleting a page referenced as a leading attribute (`Name:: value`) is out of scope there: those blocks are left as they are, are not counted in the delete preview, and the next edit to one of them recreates the page. Arthur: deleting an attribute page "would be a major error".

Make the delete refuse (409 blocker list, same dialog as query and attribute-position blockers) when the page has attribute references, listing the blocks. The pkm-wlkh blocker machinery (`unlink.plan_page_delete` blockers, `DeleteBlockedDialog`) makes this a small addition: a new reason value plus its web label.

## Todo
- [x] Blocker reason for leading `Title::` attribute references to the page
- [x] Web label for the reason
- [x] Tests (pure, endpoint 409, web dialog)

## Summary of Changes

- `unlink._blocker_reason` returns `used_as_attribute` when a source block's leading `Name::` attribute is the deleted page (after `query`, before `attribute`); DELETE refuses with 409 and the preview lists it.
- `_still_refs_page` no longer exempts a kept leading attribute naming the page (that block is now refused first).
- `DeleteBlockerModel.reason` gains the value; openapi.json + types.d.ts regenerated.
- Web label: "this page is used as an attribute" (Arthur's copy).
- backend.md blocker table and DELETE route row updated.
- Gates: server pytest/pyrefly/ruff, web verify, perf (no changes), proptest server all pass.
