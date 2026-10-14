---
# pkm-7v8l
title: Stale ops naming a renamed page's old title re-create it
status: todo
type: bug
priority: low
created_at: 2026-10-14T09:07:51Z
updated_at: 2026-10-14T09:07:51Z
---

Found in the pkm-ynze design review. Ops name pages by title. A device offline across a rename X -> Y still sends top-level create/move/create_page with page_title X, and the server re-creates X (block_rewrites retitle replay rewrites block text, not an op's page_title). With a later delete of Y, the stale op re-creates X even though pkm-ynze parks stale ops on deleted titles.

Out of scope for pkm-ynze (rename semantics). Needs its own design: e.g. resolve a stale page_title through recorded retitles within the retention window.
