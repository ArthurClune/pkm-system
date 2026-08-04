---
# pkm-apr7
title: 'jsdom ''Not implemented: navigation'' noise in PdfViewer unit tests'
status: completed
type: task
priority: low
created_at: 2026-08-04T09:54:53Z
updated_at: 2026-08-04T10:38:23Z
---

`pnpm test:unit` logs two of these, attributed to the wrong test:

```
stderr | src/components/PdfViewer.test.tsx > falls back to the download link when the document fails to load
Error: Not implemented: navigation (except hash changes)
```

Cosmetic, but it trains the eye to ignore jsdom navigation warnings -- which are worth reading, since an unprevented click leaking into a later test is a real flake source.

## What's actually happening

The warnings do not come from the test they're printed against. `PdfViewer.test.tsx`'s interactive-island test (the one asserting a Download anchor click doesn't bubble into edit mode) does `fireEvent.click` on two real anchors -- `getByRole("link", { name: "Notes" })` and `{ name: "Download" }`. Neither click is prevented, which is correct: a download link should do its native thing. jsdom then attempts a real navigation on a timer, and the warning lands on whatever test is running by then -- the next one in the file. Two clicks, two warnings.

Same root cause as the noise avoided in pkm-10ah's App test, where reading `defaultPrevented` from a document-level listener and then calling `preventDefault()` there kept jsdom quiet while still asserting the app hadn't prevented it.

## Options

- [x] Decided the approach: swallow the default in a document-level listener for the two clicks (Option a), not a `#`-fragment href. Reasoning below.
- [x] Applied it, and `pnpm test:unit 2>&1 | grep -c "Not implemented: navigation"` reports 0
- [x] Considered and implemented a stray-warning guard in `src/test-setup.ts`. Details below.

## Summary of Changes

**Approach chosen: (a), document-level listener that swallows the default -- with a twist.**

pkm-10ah's App.test.tsx pattern (a bubble-phase `document.addEventListener("click", probe)`) doesn't work as-is here: PdfViewer's own point (asserted via `onParentClick` in this very test) is that it calls `stopPropagation()` on every internal click so nothing bubbles into an enclosing block's click-to-edit handler. That stops the click from ever reaching `document` in the bubble phase, so a bubble-phase probe never fires (confirmed empirically -- `prevented` stayed `null`).

Fix: listen on `document` in the **capture** phase instead (`addEventListener("click", swallowNav, true)`). Capture runs root-to-target, before any bubbling (and therefore before any `stopPropagation()` further down can matter), so it reliably intercepts both the Notes and Download anchor clicks and calls `preventDefault()` on them before jsdom's async navigation timer would otherwise fire. The existing island assertions (`onParentClick` not called, overlay open/closed state) are untouched -- only the capture-phase listener was added/removed around them.

Did not pursue option (b) (`#`-fragment href in the fixture): the real `href` matters to this test file's other assertions (e.g. `expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("href", href)`), and faking it to a hash would weaken what's being verified about the real download link.

**Verification:** `pnpm test:unit 2>&1 | grep -c "Not implemented: navigation"` → `0`. Full `pnpm test:unit`: 122 files / 1959 tests passed, no stderr noise. Full `pnpm verify` (typecheck, lint, FCIS check, coverage, build, e2e): all green -- coverage 97.68% stmts / 93.07% branch / 95.14% funcs / 97.68% lines (thresholds 95/91/89/95); 51/51 Playwright e2e specs passed.

**Stray-warning guard: implemented in `web/src/test-setup.ts`.** It was cheap and low-risk to add: jsdom's default behavior (confirmed by reading `node_modules/jsdom/lib/api.js`) is to create `new VirtualConsole().sendTo(console)` whenever no explicit `virtualConsole` option is passed (vitest's jsdom environment doesn't pass one unless `environmentOptions.jsdom.console` is set, which this repo doesn't set), and that `sendTo` wiring calls `anyConsole.error(...)` by *looking up* `console.error` fresh at event time -- so monkey-patching `console.error` in `test-setup.ts` reliably intercepts jsdom's "Not implemented" errors, including the async, timer-scheduled ones. The guard tracks a module-level flag set when "Not implemented:" text is seen, and an `afterEach` throws (failing whichever test is currently running) if the flag is set, then clears it. This can't always attribute the failure to the actual offending test (same timing issue as the underlying bug), but it guarantees the run goes red instead of silently printing noise, which was the ask.

Verified the guard actually catches regressions: temporarily reverted the capture-phase `preventDefault()" call to a no-op, reran `pnpm test:unit", and got a hard failure ("jsdom logged an unhandled \"Not implemented\" warning: ... Not implemented: navigation") attributed to the same misattributed test as the original bug report -- then restored the real fix and reran clean (0/0, all tests passing).

One known interaction, noted in a code comment: tests that already fully silence console.error via `vi.spyOn(console, "error").mockImplementation(...)` (e.g. `ErrorBoundary.test.tsx`) bypass the guard for their duration, since they replace `console.error" entirely. That's fine -- those tests are asserting their own expected error output, not something this guard needs to police.

Branch: `worktree-agent-a898239a4c51ae6cb` (this worktree).
