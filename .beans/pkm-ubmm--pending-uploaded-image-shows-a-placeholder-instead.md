---
# pkm-ubmm
title: Pending uploaded image shows a placeholder instead of a blank line
status: completed
type: bug
priority: normal
created_at: 2026-10-13T08:35:31Z
updated_at: 2026-10-13T08:42:20Z
---

On a slow or dead connection an uncached /assets/ image renders nothing while its fetch hangs (the <img> has no size until it loads), so the block reads as an empty bullet until the request finally errors and the 'image unavailable offline' placeholder appears. Show a placeholder while the image is pending.

- [x] Failing test: a pending image renders a visible placeholder
- [x] AssetImage shows a pending placeholder until load/error
- [x] Verify in browser with /assets/ requests stalled
- [x] Docs check

## Summary of Changes

`AssetImage` now tracks pending / loaded / failed. While pending it renders the dashed placeholder box reading "loading image: <alt>" beside the img; the img's load swaps the image in, and an error swaps in "image unavailable offline". An image the browser already holds complete skips the pending state (checked in a layout effect on each src), and the label's text stays hidden for 250 ms so a quick load from the service-worker cache doesn't flash it.

Checked in Chromium with `/assets/` requests stalled (shows "loading image"), aborted (shows "unavailable offline") and working (image, no label). `pnpm verify`, eslint and `perf/check.sh frontend` (no changes against the baseline) all pass. Docs check: no architecture doc describes the image placeholder, so nothing to update.
