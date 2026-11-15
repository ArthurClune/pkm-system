---
# pkm-8tao
title: Left-nav sidebar stays on 'Couldn't load sidebar entries.' after an offline cold start
status: completed
type: bug
priority: normal
created_at: 2026-11-15T09:10:18Z
updated_at: 2026-11-15T09:13:35Z
---

Started without the network (Tailscale off) but with a cached replica: the left-nav sidebar entries never appear, and still don't after going online or navigating.

- [x] Failing test: a resync after a failed first load shows the entries
- [x] Fix SidebarNav so a successful refresh clears the load error
- [x] pnpm verify

## Summary of Changes

Symptom: the left nav shows "Couldn't load sidebar entries." (or no entries) after starting offline with a cached replica, and keeps doing so after going online and after navigating.

Cause: `SidebarNav` read `/api/sidebar` once on mount. Offline, the network fetch fails fast and falls back to the replica shim, which still answers `handled: false` while the replica opens, so the read failed with `OfflineError` and set a sticky `error`. The resync bump fired when the replica turns ready did refetch the cached entries, but nothing cleared `error`, and the component returns early on it. A first connect with an empty queue and a ready replica bumps no resync, and `SidebarNav` never remounts on navigation, so nothing else recovered it.

Fix: `applyEntries` clears `error`, so any successful read (mount, resync, post-mutation refresh) recovers. Rule stated in docs/architecture/sync-and-offline.md § When views refetch.
