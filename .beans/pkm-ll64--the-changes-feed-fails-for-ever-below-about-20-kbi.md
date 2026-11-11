---
# pkm-ll64
title: The changes feed fails for ever below about 20 kbit/s
status: scrapped
type: bug
priority: low
created_at: 2026-11-11T12:49:54Z
updated_at: 2026-11-11T13:19:30Z
parent: pkm-4gda
---

A full changes window (about 300 KB raw) cannot arrive within READ_TIMEOUT_MS on a very slow link, so the catch-up pull fails and retries for ever. Gzip moved the threshold from about 160 to about 20 kbit/s. A progress-based bound like the snapshot's stall timeout, or a smaller window on retry, would fix it. Finding C in docs/superpowers/plans/2026-11-11-w11-recovery-lease.md.


## Reasons for Scrapping

Below about 20 kbit/s is not a link the app is used on. (Arthur, 2026-11-11.)
