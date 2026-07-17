---
# pkm-jd2s
title: 'Rename follow-ups: 409 on concurrent-rename race + test hardenings'
status: in-progress
type: task
created_at: 2026-07-17T19:20:01Z
updated_at: 2026-07-17T19:20:01Z
---

Follow-ups from pkm-g0t5 final review: (1) rename_page maps sqlite3.IntegrityError (UNIQUE pages.title race between fetch_page check and commit) to 409 instead of 500; (2) endpoint test for a self-referencing block on the renamed page; (3) parity assertion pinning pkm.rename._BARE_TAG to _HASHTAG's capture class.

- [x] IntegrityError -> 409 in rename_page + test
- [x] self-referencing block rename test
- [x] _BARE_TAG/_HASHTAG parity test
