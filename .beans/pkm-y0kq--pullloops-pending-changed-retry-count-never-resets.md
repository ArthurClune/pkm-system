---
# pkm-y0kq
title: pullLoop's pending-changed retry count never resets between windows
status: todo
type: bug
created_at: 2026-10-03T16:10:14Z
updated_at: 2026-10-03T16:10:14Z
parent: pkm-nws9
---

Found in review of pkm-pp7q. replicaSync.pullLoop's pendingChangedRetries is commented as counting consecutive pending-changed refetches but is never reset when a window applies, so it counts across a whole multi-window pull. With many small windows and concurrent local edits it can reach PENDING_CHANGED_CAP (20) and raise a spurious PullStarvedError. Rare with production's 1000-row windows; likely once the sync property draws small window limits again.

- [ ] Unit reproduction
- [ ] Reset per applied window (or fix the comment if the cross-window count is intended)
