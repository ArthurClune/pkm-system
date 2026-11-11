---
# pkm-bw6z
title: Store rename, merge and delete reindexing read the plain-space flag once per link
status: todo
type: task
created_at: 2026-11-11T02:11:40Z
updated_at: 2026-11-11T02:11:40Z
parent: pkm-4gda
---

The ops path now reads the plain-space flag once per batch (title_reader passed down from apply_batch). The store paths that reindex refs on page rename, merge and delete still call get_or_create_page with canonical=None, so each resolved link reads the flag again. Pass one reader per operation, as apply_batch does, and pin the read count in a test.
