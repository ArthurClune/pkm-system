---
# pkm-12a2
title: '/link-local-file: pick a file from the server''s local docs folder and insert a Local copy:: link'
status: in-progress
type: feature
created_at: 2026-10-21T09:59:24Z
updated_at: 2026-10-21T09:59:24Z
---

Slash command opens a read-only picker over Config.local_docs_root (browse folders, or fuzzy-search the whole tree). Picking a file inserts Local copy:: [<filename>](/api/local/<encoded path>) at the cursor. Removes the manual iCloud-Files lookup and the hand/assistant URL-encoding step, which can't be validated. Design: docs/superpowers/specs/2026-10-21-link-local-file-design.md
