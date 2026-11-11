---
# pkm-1pzy
title: Copy pass over every sync banner
status: scrapped
type: task
priority: low
created_at: 2026-11-11T12:49:54Z
updated_at: 2026-11-11T13:19:30Z
parent: pkm-4gda
---

W11 added banner text ('no data from the server for 30 seconds', 'the download paused too long to finish the repair', 'Reset failed:' without the error class). Review the wording of every sync banner together for consistency and for telling the user what to do. pkm-9gkj (Reload outranks Retry) touches the same banners; do it after that.


Include LEASE_EXPIRED's text (workerHandlers.ts), 'the download paused too long to finish the repair'. The same text shows when a flush POST hung past the lease (nothing was downloading) and after a device sleep, and it does not say the action is safe to repeat. The W11 review suggested 'the repair took too long without progress; try again'.


## Reasons for Scrapping

The current sync banner wording, LEASE_EXPIRED's text included, stays as written. (Arthur, 2026-11-11.)
