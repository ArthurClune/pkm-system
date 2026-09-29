# F9: Memory-only edits are named while offline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A replica that opens and then fails every write keeps the user's
edits in the in-memory fallback lane while `availabilityOf` returns `null`
(not `"unusable"`), so no problem is ever raised, editing stays enabled, and
the "exist only in memory" warning — which today renders only inside
`ReplicaUnavailableBanner` — never shows. Make `OfflineIndicator`'s offline
`ConnectivityBanner` show that same warning whenever the lane is non-empty and
the socket is not connected, sharing one sentence-building helper with
`ReplicaUnavailableBanner` so the two banners never drift.

**Architecture:** `web/src/components/OfflineIndicator.tsx` already computes
this exact sentence inline inside `onlineOnlySafetyCopy` (for the
replica-unavailable banner, keyed on `pending`, which in that banner's state
always equals the in-memory count). Pull the sentence itself into a pure
`memoryOnlySentence(unsentInMemory: number): string | null`, keep
`onlineOnlySafetyCopy` calling it for the existing banner, and have
`ConnectivityBanner` call it too, fed by the `unsentInMemory` field
`useSyncHealth()` already exposes (`SyncProvider.tsx`'s `unsentInMemory`
state, already wired end-to-end and covered by existing `SyncProvider.test.tsx`
assertions — no provider change needed). No new file, no new CSS: both
banners keep the existing `<div className="ws-banner" role="status">` shape
and append one more sentence.

**Tech Stack:** TypeScript, React, Vitest + Testing Library (unit only — this
fix has no server, route or e2e surface).

**Spec:** `docs/superpowers/specs/2026-09-29-sync-review-fixes-design.md` §
F9 ("Memory-only edits are named while offline"), § "Shared rules", §
"Policy decisions" (the F9-vs-pkm-0htf row), § "Verification per branch".
Bean: `pkm-l3cr`.

## Global Constraints

- TDD: the three `OfflineIndicator` tests below go red, for the reason the
  bean states (no sentence appears in the offline connectivity banner today),
  before any implementation change.
- `OfflineIndicator.tsx` already declares `// pattern: Imperative Shell` and
  already keeps a pure text-generating helper (`onlineOnlySafetyCopy`) inside
  that Shell file; `memoryOnlySentence` follows the same existing precedent —
  do not create a new Functional Core file for one pure string helper this
  small.
- Code and test comments state the rule and carry no bean id. Commit messages
  may carry `pkm-l3cr`.
- Copy: lowercase only where the codebase already uses it for
  labels/buttons — this fix adds no new label or button, only a sentence
  reusing the existing "You are offline: N unsent change(s) exist only in
  memory here. Reloading or closing this tab discards it/them." wording
  verbatim. Never truncate the count or the sentence.
- No styling change: reuse the existing `ws-banner` class and `role="status"`
  exactly as both current banners already do (`docs/architecture/styling.md`
  has no token or invariant for this banner beyond that class, and this fix
  adds no new one).
- Docs land in the same branch: `docs/architecture/sync-recovery.md`'s
  "Failure modes at a glance" row for "The replica opens, then fails every
  write" and its `§ What the UI shows` gap paragraph, both rewritten to
  describe the new display rule instead of the gap, stating that it narrows
  the earlier decision to drop a degraded-write banner rather than reversing
  it (spec's Policy decisions row) — do not name that decision's bean id in
  this doc's prose (`check-docs.mjs` fails on any `pkm-xxxx` in
  `docs/architecture/` prose that is not a table row); plus one new row in
  `docs/troubleshooting.md` (symptom, cause, owning section, bean id
  `pkm-l3cr`) — bean ids in that file's table rows are fine. Run
  `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/sync-recovery.md docs/troubleshooting.md`
  after editing.
- No route, request/response shape, or docstring changes here, so no
  `openapi.json`/`gen-types` regen applies.
- No composed test across a new boundary: the boundary this fix touches
  (`SyncProvider`'s `unsentInMemory` reaching `OfflineIndicator`) is already
  wired and already asserted end-to-end in `SyncProvider.test.tsx` (lines
  asserting `sync.unsentInMemory`); the spec's own F9 "Tests" list names only
  the three `OfflineIndicator` unit tests below, no separate composed test.
- Final task: web only — `cd web && pnpm typecheck && pnpm lint && pnpm
  check:fcis && pnpm test:coverage && pnpm build`. No e2e spec is added or
  changed, so no isolated Playwright run belongs in this plan; the
  orchestrator runs the full suite and `perf/check.sh frontend` after merge.
  Then tick the bean checklist, add `## Summary of Changes`, mark the bean
  complete, and commit docs with the code.

## Review Focus

- The sentence must not appear while `status === "connected"`, even if
  `unsentInMemory` is transiently non-zero right after a reconnect and before
  the lane finishes draining — covered by the "does not name memory-only
  edits while connected" test in Task 1.
- The sentence must not appear when `pending > 0` but `unsentInMemory === 0`
  (durable rows only, replica healthy) — covered by the "only durable rows
  pending" test in Task 1.
- Singular vs. plural wording (`1 unsent change exists ... discards it` vs.
  `N unsent changes exist ... discards them`) must match exactly for
  `unsentInMemory === 1` as it already does in `ReplicaUnavailableBanner` —
  the extraction must not silently drop that branch. Covered by reusing the
  existing singular assertions against the refactored
  `ReplicaUnavailableBanner` path in Task 1's regression run.
- The `!canEdit` offline branch (read-only reason banner) must also gain the
  sentence when `unsentInMemory > 0` — the bean's decision is keyed only on
  "the lane is non-empty and the socket is not connected", not on whether
  editing is currently allowed, and a prior read-only session can still be
  carrying lane entries from before it went read-only. Covered by Task 1's
  fourth test.
- `check-docs.mjs`'s bean-id-in-prose check must pass on the edited
  `sync-recovery.md` prose (not just its table rows) — covered by running the
  script in Task 2.

---

### Task 1: `OfflineIndicator` names memory-only edits in the offline connectivity banner

**Files:**
- Modify: `web/src/components/OfflineIndicator.tsx`
- Test: `web/src/components/OfflineIndicator.test.tsx`

No other wave-2 plan touches this file or this test file.

**Interfaces:**
- Consumes: `useSyncHealth().unsentInMemory: number` (already defined in
  `web/src/sync/SyncProvider.tsx`'s `SyncHealth` interface; no change there).
- Produces: `memoryOnlySentence(unsentInMemory: number): string | null` — a
  new exported-from-module (not necessarily exported from the file; keep it
  module-private like `onlineOnlySafetyCopy` today) pure function other code
  in this file calls. No other task depends on it.

- [ ] **Step 1: Write four failing tests in `OfflineIndicator.test.tsx`**

Add near the existing offline/`ConnectivityBanner` tests (after "offline
without editing shows the read-only reason"):

```tsx
it("names memory-only edits in the offline connectivity banner", () => {
  renderWith({ status: "reconnecting", canEdit: true, pending: 3, unsentInMemory: 2 });
  const banner = screen.getByRole("status");
  expect(banner).toHaveTextContent("Offline — 3 changes pending");
  expect(banner).toHaveTextContent(
    "You are offline: 2 unsent changes exist only in memory here. "
    + "Reloading or closing this tab discards them.");
});

it("does not name memory-only edits while connected", () => {
  const { container } = renderWith({ status: "connected", pending: 0, unsentInMemory: 2 });
  expect(container).toBeEmptyDOMElement();
});

it("says nothing about the lane when only durable rows are pending", () => {
  renderWith({ status: "reconnecting", canEdit: true, pending: 2, unsentInMemory: 0 });
  const banner = screen.getByRole("status");
  expect(banner).toHaveTextContent("Offline — 2 changes pending");
  expect(banner).not.toHaveTextContent("only in memory");
});

it("names memory-only edits even while editing is paused", () => {
  renderWith({
    status: "reconnecting", canEdit: false,
    readOnlyReason: "offline — this graph is not yet available locally",
    unsentInMemory: 1,
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "1 unsent change exists only in memory here. Reloading or closing this "
    + "tab discards it.");
});
```

- [ ] **Step 2: Run the new tests and confirm all four fail**

Run: `cd web && pnpm vitest run src/components/OfflineIndicator.test.tsx`
Expected: the four new tests FAIL (no "only in memory" text is rendered by
`ConnectivityBanner` today); every pre-existing test in the file still
passes.

- [ ] **Step 3: Extract `memoryOnlySentence` and wire it into both banners in `OfflineIndicator.tsx`**

Add, above `onlineOnlySafetyCopy`:

```ts
/** The sentence naming edits that live only in this tab's memory: shared by
 * the replica-unavailable banner (every pending op is in-memory there) and
 * the offline connectivity banner (a replica can keep failing writes to the
 * fallback lane beside healthy durable rows), so both name the same risk in
 * the same words. */
function memoryOnlySentence(unsentInMemory: number): string | null {
  if (unsentInMemory === 0) return null;
  return `You are offline: ${unsentInMemory} unsent change`
    + `${unsentInMemory === 1 ? " exists" : "s exist"} only in memory here. `
    + `Reloading or closing this tab discards ${unsentInMemory === 1 ? "it" : "them"}.`;
}
```

Rewrite `onlineOnlySafetyCopy` to delegate (same external behavior, same
leading-space convention the JSX call site already relies on):

```ts
function onlineOnlySafetyCopy(status: SyncStatus, pending: number): string | null {
  if (status === "connected") {
    return " Your changes are still being saved to the server.";
  }
  const sentence = memoryOnlySentence(pending);
  return sentence === null ? null : ` ${sentence}`;
}
```

Give `ConnectivityBanner` a new `unsentInMemory: number` prop and append the
sentence (with a leading space, matching the convention above) in both its
`!canEdit` and default offline branches — not in the `status === "connected"`
branch. One reasonable shape: compute
`const memoryOnly = status === "connected" ? null : memoryOnlySentence(unsentInMemory);`
once near the top of the function, then render
`{memoryOnly !== null && ` ${memoryOnly}`}` at the end of each of those two
returned `<div>`s.

Update `OfflineIndicator()` to read `unsentInMemory` from `useSyncHealth()`
(alongside the existing `status`, `pending`, `problem`) and pass it to
`<ConnectivityBanner .../>`.

- [ ] **Step 4: Run the full file and confirm everything passes**

Run: `cd web && pnpm vitest run src/components/OfflineIndicator.test.tsx`
Expected: PASS — all four new tests and every pre-existing test in the file
(including the `replica-unavailable` singular/plural and "says nothing about
safety when ... clean" tests, which must still pass unchanged against the
refactored `onlineOnlySafetyCopy`).

- [ ] **Step 5: Typecheck and lint this file**

Run: `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/OfflineIndicator.tsx web/src/components/OfflineIndicator.test.tsx
git commit -m "fix(pkm-l3cr): name memory-only edits in the offline connectivity banner"
```

### Task 2: Docs — `sync-recovery.md` narrows the gap, `troubleshooting.md` gets its row

**Files:**
- Modify: `docs/architecture/sync-recovery.md` (the "Failure modes at a
  glance" table row for "The replica opens, then fails every write", and the
  `## Availability: two values, one owner` → `### What the UI shows`
  section's closing paragraph, currently headed "**Known gap:**")
- Modify: `docs/troubleshooting.md` (the "Sync and offline" section's table,
  after the `pkm-jyx1` row and before `## Assistant`)

No other wave-2 plan touches these two files' F9-specific rows, but several
sibling plans (F1–F8) each add their own row to the same
`docs/troubleshooting.md` table and may touch other rows of
`sync-recovery.md` — add only the lines below, do not reformat the
surrounding table.

**Interfaces:** none — prose only.

- [ ] **Step 1: Invoke the `architecture-docs` skill**

Before editing `sync-recovery.md`.

- [ ] **Step 2: Rewrite the "Failure modes at a glance" row**

Replace the current row:

```
| The replica opens, then fails every write | Nothing | Known gap | — | [What the UI shows](#what-the-ui-shows) |
```

with:

```
| The replica opens, then fails every write | `unsentInMemory > 0` while `status !== "connected"` | The offline connectivity banner appends the same "exists only in memory" sentence as the unavailable-replica banner | The sentence never fires while connected, since the lane drains within a drain cycle | [What the UI shows](#what-the-ui-shows) |
```

- [ ] **Step 3: Replace the "Known gap" paragraph in `### What the UI shows`**

Replace:

```
**Known gap:** nothing surfaces a replica that opens and then fails every write.
`availabilityOf` returns `null` for it, so no banner shows, editing stays
enabled, and the user keeps producing writes that live only in memory.
```

with a paragraph that: states `availabilityOf` still returns `null` for this
case and no problem banner mounts; states `OfflineIndicator` now appends
`memoryOnlySentence`'s output to the offline `ConnectivityBanner` whenever
`unsentInMemory > 0` and the socket is not `connected`, sharing the helper
with the table above it; states this narrows the earlier decision to drop a
degraded-write banner (that banner needed a failure counter and a threshold;
this is a display rule over the count it already tracks) rather than
reversing it. Do not name a bean id in this prose.

- [ ] **Step 4: Add the `docs/troubleshooting.md` row**

In the "Sync and offline" table, after the `pkm-jyx1` row, add:

```
| A replica that opens and then fails every write looks like healthy offline queueing, with no warning that its edits live only in memory | `availabilityOf` returns `null` for a plain `ReplicaError` (not `unusable`), so no problem banner mounts and the "exists only in memory" sentence rendered only inside the replica-unavailable banner. `OfflineIndicator`'s offline connectivity banner now appends it whenever `unsentInMemory > 0` and the socket is not connected | [sync-recovery.md § What the UI shows](architecture/sync-recovery.md#what-the-ui-shows) | pkm-l3cr |
```

- [ ] **Step 5: Run the doc checker**

Run: `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/sync-recovery.md docs/troubleshooting.md`
Expected: no `FAIL` lines (in particular no bean-id-in-prose failure and no
broken link/anchor).

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/sync-recovery.md docs/troubleshooting.md
git commit -m "docs(pkm-l3cr): sync-recovery narrows the memory-only-edits gap"
```

### Task 3: Verify, tick the bean, summarize

- [ ] **Step 1: Full web verification**

Run: `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`
Expected: all pass; coverage gate holds (only the two files in Task 1 gained
lines, both already covered by the file's existing test suite plus the four
new tests).

- [ ] **Step 2: Tick the bean checklist and add a Summary of Changes**

Run `beans show pkm-l3cr`, check off all four todo items, and append a
`## Summary of Changes` section naming the two files changed in Task 1, the
two doc files changed in Task 2, and the test count added.

- [ ] **Step 3: Mark the bean complete**

Run: `beans update pkm-l3cr --status completed`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(pkm-l3cr): tick bean checklist and summary"
```

## Self-Review

- **Spec coverage:** F9's Problem/Decision/Mechanism/Tests/Docs are all
  covered — Task 1 is the mechanism and its three named tests (plus a fourth
  for the `!canEdit` branch the spec's mechanism sentence implies but does
  not enumerate); Task 2 is the named docs.
- **Step scan:** every step names an exact function, prop, file or command;
  no step reads "handle edge cases" or leaves a signature undecided.
- **Type consistency:** `memoryOnlySentence`, `onlineOnlySafetyCopy`,
  `ConnectivityBanner`'s new `unsentInMemory: number` prop, and
  `useSyncHealth().unsentInMemory` are the same name and type everywhere they
  appear across Task 1's steps.
- **Review Focus:** all four lines above have an owning test in Task 1.
- **Proportion:** one small component file, its test file, and two doc
  edits — the plan stays a fraction of the size of the code and prose it
  describes.
