# F4: An authentication failure is not a rejection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `opQueue.ts`'s two delivery sites from treating a 401/403/408/429
as a rejected batch. Today the terminal predicate is a bare status range
(400–499), so a session expiry, a rotated secret or a cleared cookie poisons a
durable batch (or drops a lane entry) exactly like a genuinely malformed op;
after the user logs back in, the poison repair deletes an edit the server
never received.

**Architecture:** One Functional Core predicate, `isTerminalRejection`, in a
new file `web/src/sync/rejection.ts`. Both call sites in `opQueue.ts`
(`deliverLaneHead` and the durable drain's `postOps` catch) call it in place
of their inline range check. A status classified as retry-later takes the
existing non-terminal branch at each site — `failed(error)` — unchanged:
backoff retry, head/row retained, nothing written to `localStorage`, `onDesync`
never called. `apiFetch` keeps navigating to `/login` on 401 unconditionally;
that is orthogonal to this predicate and stays as is.

**Tech Stack:** TypeScript, Vitest (unit), Playwright (e2e), the existing
`memReplica` test double.

**Spec:** `docs/superpowers/specs/2026-09-29-sync-review-fixes-design.md` § F4
("An authentication failure is not a rejection"), § "Shared rules", §
"Verification per branch". Bean: `pkm-jyx1`. Consolidated review: `docs/2026-09-29-sync-subsystem-review-consolidated.md` § F4 (line 96 at commit `2a95e4a8`).

## Global Constraints

- TDD: for every behavior change, the test goes red before the fix that makes
  it green (AGENTS.md, spec "Shared rules").
- Every runtime file declares `// pattern: Functional Core` or
  `// pattern: Imperative Shell` near the top (Mixed + reason if genuinely
  unavoidable). Test files and the e2e spec are exempt.
- Code comments state the rule the code enforces and carry **no bean id**.
  Commit messages may carry `pkm-jyx1`.
- The branch includes: the doc correction the spec names for F4 (the
  `sync-recovery.md` failure-modes row, plus qualifying every "4xx" in
  `sync-recovery.md` and `sync-and-offline.md` that currently means "rejected
  as a bad batch"), and exactly one new row in `docs/troubleshooting.md`
  (symptom, cause, owning section link, bean id `pkm-jyx1`). Any edit under
  `docs/architecture/` is made after invoking the `architecture-docs` skill.
- The fix, its composed e2e test and its doc correction land in one branch
  (spec "Shared rules").
- This branch changes no route, request/response shape or docstring, so no
  `openapi.json`/`gen-types` regen is needed (spec "Shared rules" only
  requires that for a contract change).
- E2E rules (from `docs/2026-...web-e2e-testing-gotchas` conventions already
  in force in `web/e2e/`): never write to today's journal — create a
  dedicated page via `POST /api/pages` and delete it in a `finally` block;
  `.fill()` for setting a block's text, `.press()` for real key semantics
  (Escape to flush the draft, Enter to split); `pnpm build` before any direct
  Playwright invocation (`pnpm e2e` already does this); the e2e DB is shared
  across specs, so run the full suite at least once before the final report.
- Verification per branch (spec): server checks do not apply here (no server
  file changes). Web: `cd web && pnpm verify`. `perf/check.sh frontend` once, when
  the fix is complete, before merge — regression/unstable/stale handling per
  AGENTS.md.

## Review Focus

- A non-`ApiError` failure (a thrown `TypeError`, a dropped fetch, an
  `OfflineError`) must stay on the retryable path exactly as today —
  `isTerminalRejection` must return `false` for anything that is not an
  `ApiError`, not just for the four excluded statuses. Covered in Task 1's
  unit tests.
- The boundary statuses **400** (stays terminal) and **500** (already never
  reaches the predicate — the range check still gates it, but a mis-refactor
  could route it through the excluded-status branch) must not shift. Covered
  in Task 1 and Task 2.
- No `localStorage` write and no `onPoison`/`onDesync` call for a 401/403/408/429
  at either site — the easiest way to "fix" this wrong is to still write the
  poison intent and merely suppress the *delete*. Covered by explicit
  assertions in Task 2's new tests.
- The e2e's programmatic `/login` navigation can trigger the desktop unload
  guard's `beforeunload` confirm (armed whenever the in-memory lane is
  non-empty) — an un-dismissed native dialog hangs Playwright. Handled by an
  accept-any-dialog listener registered before the cookie is cleared, in
  Task 4, whether or not it actually fires in this run.
- Every doc occurrence of a bare "4xx" that means "the server rejected this
  batch" must be qualified after this change, or a reader is misled about
  which statuses retry. Task 5 grep-checks for stragglers after editing.

---

### Task 1: `isTerminalRejection` predicate (Functional Core)

**Files:**
- Create: `web/src/sync/rejection.ts`
- Create: `web/src/sync/rejection.test.ts`

**Interfaces:**
- Produces: `isTerminalRejection(error: unknown): boolean` — `true` only for
  an `ApiError` (from `web/src/api/client.ts`) whose `status` is in `[400,
  500)` and is not one of `401, 403, 408, 429`. `false` for everything else,
  including a non-`ApiError` thrown value.

- [ ] **Step 1: Write the failing tests in `web/src/sync/rejection.test.ts`**

```ts
import { expect, test } from "vitest";
import { ApiError } from "../api/client";
import { isTerminalRejection } from "./rejection";

test.each([400, 409, 413, 422])(
  "a %d ApiError is a terminal rejection", (status) => {
    expect(isTerminalRejection(new ApiError(status, "/api/ops"))).toBe(true);
  },
);

test.each([401, 403, 408, 429])(
  "a %d ApiError takes the retry-later path, not terminal", (status) => {
    expect(isTerminalRejection(new ApiError(status, "/api/ops"))).toBe(false);
  },
);

test("a 500 ApiError is not a terminal rejection", () => {
  expect(isTerminalRejection(new ApiError(500, "/api/ops"))).toBe(false);
});

test("a non-ApiError failure is not a terminal rejection", () => {
  expect(isTerminalRejection(new TypeError("network down"))).toBe(false);
});
```

- [ ] **Step 2: Run and confirm the tests fail on the missing module**

Run: `cd web && pnpm vitest run src/sync/rejection.test.ts`
Expected: FAIL — cannot resolve `./rejection` (module does not exist yet).

- [ ] **Step 3: Implement `isTerminalRejection` in `web/src/sync/rejection.ts`**

Start the file with `// pattern: Functional Core` and a short header comment
naming what the predicate is for (a 4xx from `require_auth` or a transient
overload says nothing about the batch's content, so it retries instead of
poisoning/discarding — state this
without a bean id). Pin the four excluded statuses as a `Set<number>` or
equivalent literal check: `401, 403, 408, 429`. Import `ApiError` as a type
only from `../api/client` (a plain, I/O-free class — the same cross-boundary
import `replica/errors.ts` already makes).

- [ ] **Step 4: Run and confirm the tests pass**

Run: `cd web && pnpm vitest run src/sync/rejection.test.ts`
Expected: PASS, all cases above.

- [ ] **Step 5: Commit**

```bash
git add web/src/sync/rejection.ts web/src/sync/rejection.test.ts
git commit -m "feat(pkm-jyx1): add isTerminalRejection predicate for opQueue delivery"
```

---

### Task 2: Wire the predicate into both `opQueue.ts` delivery sites

**Files:**
- Modify: `web/src/sync/opQueue.ts:468-469` (lane, inside `deliverLaneHead`'s catch)
- Modify: `web/src/sync/opQueue.ts:617` (durable, inside `runDrain`'s `postOps` catch)
- Modify: `web/src/sync/opQueue.replica.test.ts`

**Interfaces:**
- Consumes: `isTerminalRejection(error: unknown): boolean` from Task 1's
  `./rejection`.

- [ ] **Step 1: Write the failing durable-path tests**

Insert immediately after the `"a transient 503 returns retryable then the
250ms retry drains"` test (ends at line 539, just before `"dispose cancels
retry and reports the retained durable batch"` at line 541):

```ts
test.each([401, 429])(
  "a %d on a durable batch retries under backoff instead of poisoning it",
  async (status) => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        calls += 1;
        return calls === 1 ? jsonResponse({ detail: "nope" }, status)
                            : jsonResponse({ ok: true });
      }));
      const replica = memReplica();
      const q = createOpQueue(replica, () => undefined);
      const poisons: unknown[] = [];
      q.onPoison((event) => poisons.push(event));
      await q.enqueue([op("u1")]).settled;

      await expect(q.drain()).resolves.toMatchObject({
        status: "blocked", reason: "retryable", pending: 1,
      });
      expect(poisons).toEqual([]);
      expect(localStorage.getItem("pkm.poison-mark-intents.v1")).toBeNull();
      await vi.advanceTimersByTimeAsync(250);
      await expect(q.drain()).resolves.toEqual({ status: "drained" });
      await expect(replica.pendingCount()).resolves.toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
```

Insert immediately after `"a 4xx emits batch details and pauses later
delivery before notifying"` (ends at line 141, just before `"a 4xx raises the
internal poison barrier before durable mark resolves"` at line 143) a
regression pin for the statuses that must stay terminal:

```ts
test.each([409, 422])(
  "a %d on a durable batch still poisons it (stays terminal)", async (status) => {
    const { bodies } = fetchSeq([
      () => jsonResponse({ detail: "still bad" }, status),
      () => jsonResponse({ ok: true }),
    ]);
    const replica = memReplica();
    const q = createOpQueue(replica, () => undefined);
    const poisons: unknown[] = [];
    q.onPoison((event) => poisons.push(event));
    q.enqueue([op("bad")]);
    q.enqueue([op("good")]);
    await q.settled();
    const outcome = await q.drain();
    expect(poisons).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "blocked", reason: "recovering" });
    expect(bodies).toHaveLength(1); // the good batch waits for repair
  },
);
```

- [ ] **Step 2: Write the failing lane-path tests**

Insert immediately after `"a 5xx keeps the retained op under the same batch
id and the backoff retry delivers it"` (ends at line 1414, just before `"a
transport failure on a retained op keeps it for the next drain"` at line
1418):

```ts
test.each([401, 429])(
  "a %d keeps the retained lane op under the same batch id and the backoff retry delivers it",
  async (status) => {
    vi.useFakeTimers();
    try {
      const { bodies } = fetchSeq([
        () => jsonResponse({ detail: "nope" }, status),
        () => jsonResponse({ ok: true }),
      ]);
      const replica = laneOnlyReplica();
      const desyncs: unknown[] = [];
      const q = createOpQueue(replica, (e) => desyncs.push(e));
      const ticket = q.enqueue([op("u1")]);
      await q.settled();

      await expect(q.drain()).resolves.toMatchObject({
        status: "blocked", reason: "retryable", pending: 1,
      });
      expect(desyncs).toEqual([]);
      await vi.advanceTimersByTimeAsync(250);
      await expect(q.drain()).resolves.toEqual({ status: "drained" });
      await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
      const ids = bodies.map((b) => (b.body as { batch_id: string }).batch_id);
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe(ids[1]);
    } finally {
      vi.useRealTimers();
    }
  },
);
```

Insert immediately after `"a 4xx discards only the rejected retained op and
holds the rest behind repair"` (ends at line 1465, just before `"a retained
op still delivers immediately when pendingCount() misreports a backlog"` at
line 1472):

```ts
test.each([409, 422])(
  "a %d still discards only the rejected retained op (stays terminal)", async (status) => {
    const { bodies } = fetchSeq([
      () => jsonResponse({ detail: "still bad" }, status),
      () => jsonResponse({ ok: true }),
    ]);
    const replica = laneOnlyReplica();
    const desyncs: unknown[] = [];
    const q = createOpQueue(replica, (e) => desyncs.push(e));
    const bad = q.enqueue([op("bad")]);
    const good = q.enqueue([op("good")]);
    await q.settled();

    await expect(q.drain()).resolves.toMatchObject({
      status: "blocked", reason: "recovering", pending: 1,
    });
    await expect(bad.delivered).resolves.toMatchObject({ status: "failed" });
    expect(desyncs).toHaveLength(1);
    expect(bodies).toHaveLength(1);
  },
);
```

- [ ] **Step 3: Run and confirm the four new `test.each` blocks fail**

Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts`
Expected: the two `401`/`429` retry-later blocks FAIL (today's predicate
still poisons/discards them); the two `409`/`422` terminal-stays blocks
already PASS unmodified — they pin current behavior rather than drive a
change.

- [ ] **Step 4: Wire the predicate at both sites in `web/src/sync/opQueue.ts`**

Add `import { isTerminalRejection } from "./rejection";` near the existing
`ApiError` import (line 5). Replace the two-line condition at 468-469
(`error instanceof ApiError && error.status >= 400 && error.status < 500`)
and the one-line condition at 617 (same expression) with
`isTerminalRejection(error)`. Leave every other line of `deliverLaneHead` and
the durable catch block unchanged — `failed(error)` (the existing `else`
branch at both sites) already implements the retry-later behavior: backoff
schedule, retained head/row, no `localStorage` write, no `onDesync`.

- [ ] **Step 5: Run and confirm all of `opQueue.replica.test.ts` passes**

Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts`
Expected: PASS, including the two new retry-later blocks and the two
terminal-stays blocks.

- [ ] **Step 6: Run the full unit suite**

Run: `cd web && pnpm test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/sync/opQueue.ts web/src/sync/opQueue.replica.test.ts
git commit -m "fix(pkm-jyx1): opQueue retries 401/403/408/429 instead of treating them as rejection"
```

---

### Task 3: E2E — a cleared session cookie retries and delivers, it does not lose the edit

**Files:**
- Create: `web/e2e/auth-retry.spec.ts`

**Interfaces:**
- Consumes: the fix from Task 2 (nothing directly — this drives it through
  the real server and a real browser). Uses the existing `POST /api/pages` /
  `DELETE /api/page/<title>` pattern from `web/e2e/goodlinks.spec.ts` and the
  `routeWebSocket` + `context.setOffline` connectivity control from
  `web/e2e/offline.spec.ts`, and `waitForServerText` from `web/e2e/server-state.ts`.

- [ ] **Step 1: Write the composed e2e test**

```ts
// A session that expires mid-drain (cleared cookie, rotated secret) must not
// lose the edit it was delivering: the durable batch retries instead of
// being poisoned, and the repair that runs after login must not delete it.
import { type Page, type WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
}

const input = (page: Page) => page.locator("textarea.block-input");

test("a session that expires mid-drain retries and delivers instead of losing the edit",
async ({ page, context }) => {
  test.setTimeout(60_000);
  let offline = false;
  const live: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/api\/ws$/, (ws) => {
    if (offline) { void ws.close(); return; }
    ws.connectToServer();
    live.push(ws);
  });

  await login(page);
  const title = `Auth Retry E2E ${Date.now()}`;
  const createRes = await page.request.post("/api/pages", { data: { title } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);

  try {
    // hold the edit in the durable queue: nothing can deliver while offline
    offline = true;
    await context.setOffline(true);
    for (const ws of live.splice(0)) await ws.close();

    await page.getByText("Click to start writing…").click();
    await input(page).fill("edit survives a session expiry");
    await input(page).press("Escape"); // blur: flushes the draft op
    await expect(page.locator(".ws-banner")).toContainText(/\d+ changes? pending/);

    // the session is gone before the drain ever gets a chance to deliver
    await context.clearCookies();
    // the desktop unload guard may fire a beforeunload confirm on the
    // programmatic /login navigation below if the in-memory lane is
    // non-empty; never let that hang the run
    page.on("dialog", (dialog) => { void dialog.accept(); });

    offline = false;
    await context.setOffline(false);

    // apiFetch's onUnauthorized redirects unconditionally on 401
    await page.waitForURL("**/login", { timeout: 20_000 });
    await page.fill("#pw", PASSWORD);
    await page.click("text=log in");
    await page.waitForURL("**/");

    // retained, not poisoned: the retry after login delivers it
    await waitForServerText(page, title, "edit survives a session expiry");
  } finally {
    await page.request.delete(`/api/page/${encodeURIComponent(title)}`);
  }
});
```

- [ ] **Step 2: Build the web bundle**

Run: `cd web && pnpm build`

- [ ] **Step 3: Confirm the spec is red against the pre-Task-2 predicate, then green with it**

`git stash` (or a throwaway local revert of) the one-line predicate swap from
Task 2 Step 4 in `web/src/sync/opQueue.ts` — put the original
`error instanceof ApiError && error.status >= 400 && error.status < 500`
check back at both sites — then run:
`cd web && pnpm e2e -- auth-retry`
Expected: FAIL (`waitForServerText` times out — the pre-fix predicate
poisons the batch and the post-login repair deletes it). Restore Task 2's
fix (`git stash pop`, or re-apply the swap) and run the same command again.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/e2e/auth-retry.spec.ts
git commit -m "test(pkm-jyx1): e2e — a cleared session cookie retries and delivers the edit"
```

---

### Task 4: Docs — qualify "4xx", add the failure-modes row, add the troubleshooting row

Invoke the `architecture-docs` skill before editing anything under
`docs/architecture/`.

**Files:**
- Modify: `docs/architecture/sync-recovery.md:26` (failure-modes table)
- Modify: `docs/architecture/sync-recovery.md:74`
- Modify: `docs/architecture/sync-recovery.md:91`
- Modify: `docs/architecture/sync-recovery.md:229`
- Modify: `docs/architecture/sync-and-offline.md:210-226` (the reconnect-drain mermaid sequence + its prose)
- Modify: `docs/troubleshooting.md` (Sync and offline section, after the `pkm-8k2c` row)

- [ ] **Step 1: Invoke the `architecture-docs` skill**

- [ ] **Step 2: Qualify `sync-recovery.md`'s failure-modes table (line 26) and add a new row**

Reword the existing "The server answers 4xx for a durable batch" row so its
"Detected by" and "Response" columns describe only a *terminal* 4xx (exclude
401/403/408/429 by naming `isTerminalRejection`), and add one new row
directly beneath it: "The server answers 401, 403, 408 or 429" / detected by
`isTerminalRejection` returning false / retained under backoff exactly like a
5xx, `apiFetch` still redirects to `/login` / linking to the same
[A batch the server rejects](#a-batch-the-server-rejects) anchor (or a new
anchor if the skill's structure calls for a short dedicated aside there —
follow the skill's guidance on where a one-line qualification suffices versus
where a new row/section earns its place).

- [ ] **Step 3: Qualify the remaining bare "4xx" mentions**

At line 74 ("a lane entry's 4xx discard"), line 91 ("rejected with a 4xx...
That 4xx is the only discard"), and line 229 ("A 4xx on a durable batch marks
its row poisoned"), qualify each to say a *terminal* 4xx (or "a 4xx other
than 401/403/408/429"), matching whichever short phrase the skill prefers for
consistency across the file.

- [ ] **Step 4: Qualify `sync-and-offline.md`'s reconnect-drain diagram**

In the mermaid sequence (lines ~204-218), add a branch between "first
delivery" and "else 4xx (bad batch)" for the retry-later statuses (row stays
queued, backoff retry — same outcome as the `5xx / network error` branch),
and qualify the "4xx (bad batch)" label so it reads as a terminal rejection.
Update the "The 4xx branch's repair is in..." sentence at line 226 the same
way.

- [ ] **Step 5: Add the troubleshooting row**

In `docs/troubleshooting.md`'s "Sync and offline" section (after the
`pkm-8k2c` row), add:

`| A durable batch (or lane entry) is poisoned or dropped after a session expiry, a rotated secret or a cleared cookie, and the post-login repair deletes an edit the server never received | The terminal predicate for a delivery failure was a status range (400-499), not a list — 401, 403, 408 and 429 were treated exactly like a genuinely rejected batch | [sync-recovery.md § A batch the server rejects](architecture/sync-recovery.md#a-batch-the-server-rejects) | pkm-jyx1 |`

- [ ] **Step 6: Grep for any remaining unqualified "4xx" that means rejected**

Run: `grep -n "4xx" docs/architecture/sync-recovery.md docs/architecture/sync-and-offline.md`
Expected: every remaining hit either already says "terminal"/excludes the
four statuses, or does not describe rejection at all (e.g. a table header).
Fix any straggler found.

- [ ] **Step 7: Commit**

```bash
git add docs/architecture/sync-recovery.md docs/architecture/sync-and-offline.md docs/troubleshooting.md
git commit -m "docs(pkm-jyx1): qualify 4xx as terminal-only and record the auth-retry fix"
```

---

### Task 5: Final verification, bean checklist, and merge-readiness

- [ ] **Step 1: Full web verification**

Run: `cd web && pnpm verify`
Expected: PASS (typecheck, lint, FCIS check, coverage-enforced unit tests,
build, full Playwright suite — including `auth-retry.spec.ts` and every
other spec, since the e2e DB is shared).

- [ ] **Step 2: Performance check**

Run: `perf/check.sh frontend`
Expected: no regression. If unstable, file a bean against the perf harness
and continue (AGENTS.md). If stale, `perf/check.sh frontend --rebaseline`. A
genuine regression: read the diff on the regressed path, fix, re-run; only
escalate if it survives, with the table and findings.

- [ ] **Step 3: Update the bean**

Run: `beans show pkm-jyx1` to confirm current state, then check off every
Todo item (failing queue tests; `isTerminalRejection`; the e2e; the docs) and
add a `## Summary of Changes` section to the bean body naming: the new
`web/src/sync/rejection.ts` predicate, the two `opQueue.ts` call sites now
routed through it, the new unit tests (retry-later and terminal-stays,
durable and lane), the new e2e spec, and the three doc edits. Mark the bean
completed.

- [ ] **Step 4: Commit the bean update with the code**

```bash
git add <bean files>
git commit -m "chore(pkm-jyx1): mark F4 complete"
```
