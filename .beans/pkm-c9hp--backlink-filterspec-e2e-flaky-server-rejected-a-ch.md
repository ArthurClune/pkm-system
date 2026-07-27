---
# pkm-c9hp
title: 'backlink-filter.spec e2e flaky: ''Server rejected a change'' outline repair detaches editor'
status: in-progress
type: bug
priority: normal
created_at: 2026-07-26T21:10:51Z
updated_at: 2026-07-27T17:50:45Z
---

e2e/backlink-filter.spec.ts ('linked-refs filter: include, exclude, ancestor tags, pkm-m4an') fails intermittently (~70% standalone on 2026-07-26, at main f16c88e, unrelated to any pending change — reproduced with clean tree + fresh build). Failure mode: while typing the scenario blocks, the page shows the banner 'Server rejected a change. Active outlines repaired.', the outline resets to 'Click to start writing…', and textarea.block-input detaches forever -> 30s timeout at spec line ~48. When it passes it passes fast (1.3s). Likely the resyncSeq/op-rejection remount churn family. Needs systematic-debugging: capture the rejected op + server response in e2e_serve.py exception/request logs.
