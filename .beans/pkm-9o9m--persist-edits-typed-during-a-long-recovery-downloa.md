---
# pkm-9o9m
title: Persist edits typed during a long recovery download
status: scrapped
type: feature
priority: low
created_at: 2026-11-11T12:49:54Z
updated_at: 2026-11-11T13:19:30Z
parent: pkm-4gda
---

After W11 the recovery gate stays held for the whole snapshot download (about 35 s at 400 kbit/s compressed, longer on slower links); edits typed meanwhile live in memory until commit. An iOS home-screen app honours no beforeunload, so closing it in that window loses them. Arthur accepted this default for W11 and asked for this bean. Let enqueued edits persist during the download without breaking commitRecovery's fingerprint guard.


## Reasons for Scrapping

Not a regression: before W11 edits lived in memory for up to the 120 s lease too. Gzip cut the window to about 15-35 s on very slow links and a second or two on normal ones, and a loss needs a recovery, an edit and the iOS app being killed inside it. The fix would have to work around commitRecovery's pending-row fingerprint guard, too costly for that exposure. (Arthur, 2026-11-11.)
