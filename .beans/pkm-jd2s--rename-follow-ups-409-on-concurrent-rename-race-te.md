---
# pkm-jd2s
title: 'Rename follow-ups: 409 on concurrent-rename race + test hardenings'
status: completed
type: task
priority: normal
created_at: 2026-07-17T19:20:01Z
updated_at: 2026-07-17T19:27:54Z
---

Follow-ups from pkm-g0t5 final review: (1) rename_page maps sqlite3.IntegrityError (UNIQUE pages.title race between fetch_page check and commit) to 409 instead of 500; (2) endpoint test for a self-referencing block on the renamed page; (3) parity assertion pinning pkm.rename._BARE_TAG to _HASHTAG's capture class.

- [x] IntegrityError -> 409 in rename_page + test
- [x] self-referencing block rename test
- [x] _BARE_TAG/_HASHTAG parity test

## Summary of Changes

- `rename_page` now wraps its mutation+commit in `try/except sqlite3.IntegrityError` → rollback + 409 (same detail as the normal collision), closing the concurrent-rename race that previously surfaced as a 500. Comment documents that this labeling relies on `rename_page_rows` retitling pages first and refs inserts being INSERT OR IGNORE.
- New test simulates the race with a genuine mid-request UNIQUE(pages.title) violation (monkeypatched wrapper inserts the conflicting row on the same connection), asserting 409 and source-page survival.
- New test pins self-referencing-block behavior: a block on the renamed page containing its own `[[Title]]` gets rewritten and keeps its refs row targeting the same page id.
- New parity test pins `pkm.rename._BARE_TAG` to `pkm.refs._HASHTAG`'s capture class bidirectionally (either regex drifting breaks it).
- Reviewed (approved); 436 server tests passing with coverage gate, ruff + pyrefly clean.
