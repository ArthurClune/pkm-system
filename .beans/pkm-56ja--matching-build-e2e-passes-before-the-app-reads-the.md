---
# pkm-56ja
title: Matching-build e2e passes before the app reads the header
status: completed
type: bug
priority: normal
created_at: 2026-11-19T20:51:35Z
updated_at: 2026-11-19T20:54:47Z
---

web/e2e/stale-build.spec.ts 'a matching build shows no banner' asserted no .stale-build banner as soon as the first API response's headers arrived, before apiFetch read X-Pkm-Build and React rendered, so a bundle whose id disagrees with build-id.json (banner on every load in production) would still pass. The second spec forces a mismatch, so it never covers agreement.

Fix: wait for the page to render and the network to settle before asserting no banner, and compare the header with /build-id.json. Prove it with a mutant whose bundle and file ids differ.

- [x] Tighten the spec
- [x] Mutant fails it
- [x] Full e2e run

## Summary of Changes

The test now logs in itself (ownPage's wait for `.ws-banner` to clear
failed first on a mismatch, since the stale banner shares that class),
checks the header equals `/build-id.json`, and asserts no `.stale-build`
only after the scratch page has rendered and the network is idle. A mutant
plugin writing a different id to `build-id.json` than to the bundle now
fails this test at its own assertion; the real build passes, and the full
Playwright suite passes. The rule it guards is in
docs/architecture/frontend.md § Build notes.
