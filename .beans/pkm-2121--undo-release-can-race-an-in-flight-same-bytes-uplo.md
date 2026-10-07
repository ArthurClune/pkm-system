---
# pkm-2121
title: Undo release can race an in-flight same-bytes upload response
status: todo
type: bug
priority: low
created_at: 2026-10-07T21:05:01Z
updated_at: 2026-10-07T21:05:01Z
---

Residual race left by pkm-w4ts (undo releases orphaned uploads). The release skips a sha re-uploaded in this tab since the undo, but `uploadAsset` (`web/src/sync/assets.ts`) stamps the upload clock only when the response arrives. If the server has already processed a same-bytes re-upload (`existing: true`) and the release's `keep` check runs before the client receives that response, the conditional DELETE goes out and succeeds; the client then lands a block naming a deleted file.

Window: one response leg (milliseconds), and it needs the undo and the clearing edit delivered while the redrop's response is in transit. Found by the final re-review of pkm-w4ts.

Fix options:
- count in-flight uploads and defer the release (re-checking the clock) while any is pending; or
- hash locally (`replica/sha256`) and stamp the clock at upload start.
