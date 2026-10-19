---
# pkm-i6uo
title: 'useOutline.dropFiles test logs ''asset release failed'' TypeError: unit run is not clean'
status: completed
type: bug
priority: normal
created_at: 2026-10-19T09:51:17Z
updated_at: 2026-10-19T12:38:59Z
---

`pnpm test:unit` / `pnpm verify` print two stderr blocks from web/src/outline/useOutline.dropFiles.test.tsx, test "one undo removes every new block":

    asset release 6363…63 failed TypeError: Cannot read properties of undefined (reading 'get')
      at useOutline.dropFiles.test.tsx (fetch mock) <- releaseAssets (sync/assetRelease.ts)

The test's fetch mock reads `(init.body as FormData).get("file")` for every call, but undoing an upload now releases its files (pkm-qibv), and the release request has no FormData body, so the mock throws and assetRelease logs the failure. The test passes; the checks are not clean. Arthur wants completely clean checks.

- [x] Make the mock answer the release request (or route by URL) so undo's release succeeds, and assert the release call where the test means it
- [x] Check the rest of the unit run for other stderr noise and fix it the same way
- [x] Make stray console.warn/error fail the unit run (vitest onConsoleLog or a setup spy) so noise cannot return unseen (Arthur, 2026-10-19: in scope, not optional); fix whatever noise it surfaces first

## Summary of Changes

- useOutline.dropFiles.test.tsx: the fetch mock answers the release DELETE; the undo test asserts one release per new file (releaseUrl).
- PdfFallbackLink.test.tsx: the onDownload double prevents default, as PdfEmbed's real handler does.
- src/test-setup.ts: console guard. Any unsilenced console.warn/error fails the running test (afterEach, after cleanup) or the file when it lands after the last test (afterAll after one real macrotask). Replaces the narrower "Not implemented" guard.
- Teeth: tooling/consoleGuard.test.ts runs *.guard.ts fixtures in a vitest subprocess (warn, error, late timer, silenced, clean).
- Docs: enforced-checks.md row, frontend.md unit bullet, troubleshooting row updated.
