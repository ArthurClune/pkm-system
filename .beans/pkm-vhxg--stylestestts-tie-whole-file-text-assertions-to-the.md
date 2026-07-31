---
# pkm-vhxg
title: 'styles.test.ts: tie whole-file text assertions to the rule they mean'
status: completed
type: task
priority: normal
created_at: 2026-07-30T08:03:41Z
updated_at: 2026-07-31T08:32:10Z
---

Follow-on from pkm-0wg9. That bean added a `rulesFor(selector)` helper to `web/src/styles.test.ts` (it returns every rule body whose selector text names the given selector, joined) and converted one brittle whole-file assertion to use it. One genuine case was left behind.

`styles.test.ts` is a text-level drift guard: it reads `styles.css` as a string. Most assertions go through `ruleFor`/`rulesFor` and are therefore anchored to a named rule. A handful use `expect(styles).toContain(...)` against the whole stylesheet, which passes if the string appears **anywhere** — so the assertion no longer proves the declaration is on the rule the test names.

## The one to fix

`styles.test.ts:109`, test "phone top bar clears the fixed hamburger button":

```ts
expect(styles).toContain("padding: 8px 16px 8px 52px;");
```

That padding belongs to `.top-bar` inside the `@media (max-width: 600px)` block (`styles.css:667`), where the extra 52px of left padding clears the fixed hamburger button. As written the test would stay green if someone moved that padding onto an unrelated selector, which is exactly the drift it exists to catch. `rulesFor(".top-bar")` joins the base rule (`styles.css:355`) and the phone rule (`:667`), so:

```ts
expect(rulesFor(".top-bar")).toContain("padding: 8px 16px 8px 52px;");
```

anchors it while still finding the value inside the media query.

## Deliberately NOT in scope

Four remaining `expect(styles)` assertions are correct as they are, because they assert *structure* or *global absence* — neither of which `rulesFor` can express. Do not "fix" these:

- `:293` — `".input-control, .search-field-input {"` asserts the two selectors are still **grouped in one rule**. `rulesFor` would pass on two separate rules carrying the right values, which is the drift this guards.
- `:100` and `:304` — `".top-bar-search-input:focus + .top-bar-search-hint,"` asserts the adjacent-sibling selector survives, which is what pins the kbd chip to being the input's immediate next sibling (pkm-absu).
- `:137` — `not.toContain("border-radius: 3px;")` asserts stray 3px radii are gone from the **whole file** (currently 0 occurrences). A per-rule check cannot express "nowhere".

## Notes

- `styles.test.ts` is the only test file that reads `styles.css`, so the sweep is confined to it. Current shape: 75 `ruleFor` calls, 4 `rulesFor`, 5 `expect(styles)`.
- Beware `ruleFor`'s known limitation, which is why `rulesFor` exists: it builds an **unanchored** regex `selector\s*\{([^}]*)\}` and returns the **first** match, so a selector appearing as a non-first member of a grouped rule (`.input-control, .search-field-input {`) resolves to the grouped rule, not its own. Use `rulesFor` whenever a class's declarations are split across rules.

- [x] Convert `styles.test.ts:109` to `rulesFor(".top-bar")`
- [x] Confirm it fails if the padding is moved to another selector (prove the assertion got stronger)
- [x] Leave the four structural/global assertions alone
- [x] `cd web && pnpm vitest run src/styles.test.ts`

## Summary of Changes

Converted the one remaining unanchored assertion in `web/src/styles.test.ts` (test "phone top bar clears the fixed hamburger button", in this checkout at line 139) from `expect(styles).toContain(...)` to `expect(rulesFor(".top-bar")).toContain("padding: 8px 16px 8px 52px;")`. `rulesFor` joins the base `.top-bar` rule (`styles.css:369`) and the phone `@media (max-width: 600px)` rule (`styles.css:709`), so the value is still found inside the media query but the assertion is now anchored to `.top-bar` specifically.

Proved the assertion got stronger: temporarily moved the `padding: 8px 16px 8px 52px;` declaration in `styles.css` from the phone `.top-bar` rule onto the neighbouring `.main-pane` rule (string still present in the file). The new `rulesFor(".top-bar")` assertion failed as expected (`AssertionError: expected ... to contain 'padding: 8px 16px 8px 52px;'`) — proving it would have caught the exact drift the old whole-file `toContain` could not. Reverted `styles.css` via `git checkout --`, confirmed `git diff --stat` showed no changes to it, and re-ran the suite: 56/56 tests pass.

Left the four structural/global `expect(styles)` assertions (grouped-selector check, two adjacent-sibling checks, and the whole-file `not.toContain("border-radius: 3px;")` absence check) untouched, as specified — `rulesFor` cannot express any of those.

Verification: `pnpm vitest run src/styles.test.ts` — 56 passed; `pnpm typecheck` — clean. E2E/`pnpm verify` intentionally skipped per instructions (another agent using the E2E port; change is test-file-only and cannot affect E2E).
