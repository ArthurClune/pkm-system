---
# pkm-hc95
title: 'Brand check for titles: name says which title kind'
status: todo
type: task
created_at: 2026-10-17T15:30:18Z
updated_at: 2026-10-17T15:30:18Z
---

The brand check (pkm-zv2s) registers names like `uid` and `page_id` that
must carry their brand, but leaves `title` out: a `title` parameter is
variously raw user text, NormalizedTitle or CanonicalTitle, and the web
alone has about 99 `title: string` sites.

Decide how titles get the same treatment: rename parameters so the name
says which kind they hold (e.g. `raw_title` / `canonical_title`), then
register those names with the brand check. Survey server and web first;
count the sites per kind before choosing names.
