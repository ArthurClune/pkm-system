# Block timestamps in the page margin (pkm-4ler) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a page-menu preference is on, every block on a main-pane page shows its last-changed date in a fixed-width right-hand margin column, tinted by age, and that date stays honest while you edit.

**Architecture:** A new pure module `web/src/outline/blockStamps.ts` decides which timestamp a row shows, which age band tints it, how it reads, and which ops count as a change. `transitionOutline` (the one reducer both local and remote op batches pass through) stamps `updated_at` on the uids a batch changed, using an `nowMs` supplied by the shell. The column itself is the last flex child of `.block-row`, gated by a `stamps` **prop** that only `PageView` passes — so the journal scroll and sidebar panels stay bare by construction. The preference is a localStorage-backed global, split core/hook like `sidebar.ts`/`useSidebarCollapsed.ts`, and shared through a context so TopBar's toggle and PageView's read cannot disagree.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest (+ @testing-library/react, jsdom), Playwright, plain CSS with custom-property design tokens.

**Spec:** `docs/superpowers/specs/2026-08-03-pkm-4ler-block-timestamps-design.md`
**Bean:** pkm-4ler (currently `draft`; Task 1 flips it to `in-progress`)
**Branch:** `pkm-4ler-block-timestamps` (already checked out; work in place, no new worktree)

## Global Constraints

- **FCIS headers are mandatory.** Every new runtime `.ts`/`.tsx` file must declare `// pattern: Functional Core` or `// pattern: Imperative Shell` on an early line. `pnpm check:fcis` fails the build otherwise, and a Functional Core module may never import an Imperative Shell module (value imports; `import type` is erased and allowed).
- **Clock rule.** `Date.now()` / `new Date()` with no argument belong in Imperative Shell files only. Core functions take the instant as a parameter.
- **Coverage gates are enforced** by `vitest run --coverage`: statements 95, branches 91, functions 89, lines 95. Every new function needs a test.
- **Three theme blocks.** Any new `--color-*` token must be declared in **all three**: `:root` (light), `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`, and `:root[data-theme="dark"]`. `styles.test.ts` pins this.
- **Timestamps are epoch milliseconds** and both `BlockNode.created_at` and `BlockNode.updated_at` are `number | null`.
- **Dates render in local time.** Tests must build expected values from local-time `Date` constructors (`new Date(2026, 7, 3, 14, 22)`), never UTC string literals, so they pass in any TZ.
- **Full gates before completion:** `cd server && uv run pytest -q`, `cd server && uv run pyrefly check`, `cd server && uv run ruff check`, `cd web && pnpm verify`. (No server code changes here, but the server gates still get one run at the end.)
- **Commit convention:** `feat(pkm-4ler): …` / `test(pkm-4ler): …` / `docs(pkm-4ler): …`. Commit bean file changes together with code.
- **Never start a dev server on port 8974** — the production launchd service owns it on this machine.

---

### Task 1: The stamp core (`outline/blockStamps.ts`)

Pure module: which timestamp a row shows, its age band, its text, its hover title, and which ops count as a change. Nothing here touches the DOM or the clock.

**Files:**
- Create: `web/src/outline/blockStamps.ts`
- Create: `web/src/outline/blockStamps.test.ts`
- Modify: `.beans/pkm-4ler--expose-block-createdlast-changed-timestamps-in-the.md` (via the `beans` CLI)

**Interfaces:**
- Consumes: `BlockNode` from `../api/payloads`, `BlockOp` from `../api/ops` (both type-only).
- Produces (later tasks rely on these exact names):
  - `type StampBand = "week" | "month" | "year" | "older"`
  - `stampTs(node: Pick<BlockNode, "created_at" | "updated_at">): number | null`
  - `stampBand(nowMs: number, ts: number): StampBand`
  - `formatStamp(ts: number): string` → `"3 Aug 26"`
  - `formatStampTitle(ts: number): string` → `"3 August 2026, 14:22"`
  - `opBumpsUpdatedAt(op: BlockOp): boolean`
  - `bumpedUids(ops: readonly BlockOp[]): string[]`

- [ ] **Step 1: Put the bean in progress**

```bash
cd /Users/arthur/code/llm/pkm
beans update --json pkm-4ler -s in-progress --body-append "$(cat <<'EOF'

## Implementation checklist (plan 2026-08-03-pkm-4ler-block-timestamps.md)

- [ ] Task 1: outline/blockStamps.ts core + tests
- [ ] Task 2: reducer stamps updated_at from an nowMs supplied by the shell
- [ ] Task 3: "Show timestamps" preference (core + hook + context + TopBar item)
- [ ] Task 4: the margin cell (EditableBlockTree/EditablePage/PageView)
- [ ] Task 5: tokens, .block-stamp styles, phone hide
- [ ] Task 6: Playwright pass
- [ ] Task 7: architecture docs + full gates
EOF
)"
```

- [ ] **Step 2: Write the failing tests**

Create `web/src/outline/blockStamps.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import {
  bumpedUids,
  formatStamp,
  formatStampTitle,
  opBumpsUpdatedAt,
  stampBand,
  stampTs,
} from "./blockStamps";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 7, 3, 12, 0).getTime(); // 3 Aug 2026, local noon

describe("stampTs", () => {
  test("prefers updated_at", () => {
    expect(stampTs({ created_at: 1000, updated_at: 2000 })).toBe(2000);
  });

  test("falls back to created_at when updated_at is null", () => {
    expect(stampTs({ created_at: 1000, updated_at: null })).toBe(1000);
  });

  test("is null when the block has neither", () => {
    expect(stampTs({ created_at: null, updated_at: null })).toBeNull();
  });
});

describe("stampBand", () => {
  test.each([
    ["exactly 7 days old is still this week", 7 * DAY, "week"],
    ["a moment past 7 days is this month", 7 * DAY + 1, "month"],
    ["exactly 31 days old is still this month", 31 * DAY, "month"],
    ["a moment past 31 days is this year", 31 * DAY + 1, "year"],
    ["exactly 365 days old is still this year", 365 * DAY, "year"],
    ["a moment past 365 days is older", 365 * DAY + 1, "older"],
  ])("%s", (_label, age, band) => {
    expect(stampBand(NOW, NOW - age)).toBe(band);
  });

  test("a future timestamp (clock skew) reads as freshest, not oldest", () => {
    expect(stampBand(NOW, NOW + DAY)).toBe("week");
  });
});

describe("formatStamp", () => {
  test("renders a compact day/month/two-digit-year", () => {
    expect(formatStamp(new Date(2026, 7, 3, 14, 22).getTime())).toBe("3 Aug 26");
  });

  test("pads years below 2010 to two digits", () => {
    expect(formatStamp(new Date(2009, 0, 9).getTime())).toBe("9 Jan 09");
  });
});

describe("formatStampTitle", () => {
  test("gives the full local date and zero-padded time for hover", () => {
    expect(formatStampTitle(new Date(2026, 7, 3, 14, 22).getTime()))
      .toBe("3 August 2026, 14:22");
    expect(formatStampTitle(new Date(2026, 7, 3, 9, 5).getTime()))
      .toBe("3 August 2026, 09:05");
  });
});

describe("opBumpsUpdatedAt", () => {
  const cases: Array<[BlockOp, boolean]> = [
    [{ op: "create", uid: "u1", page_title: "P", parent_uid: null,
       order_idx: 0, text: "hi" }, true],
    [{ op: "update_text", uid: "u1", text: "hi" }, true],
    [{ op: "move", uid: "u1", parent_uid: null, order_idx: 1 }, true],
    [{ op: "set_heading", uid: "u1", heading: 2 }, true],
    [{ op: "set_view_type", uid: "u1", view_type: "numbered" }, true],
    // pkm-r7k8: collapsing is a view toggle, not a change
    [{ op: "set_collapsed", uid: "u1", collapsed: true }, false],
    [{ op: "delete", uid: "u1" }, false],
    [{ op: "create_page", page_title: "P" }, false],
  ];
  test.each(cases)("%o -> %s", (op, expected) => {
    expect(opBumpsUpdatedAt(op)).toBe(expected);
  });
});

describe("bumpedUids", () => {
  test("collects changed uids once each, skipping non-changes", () => {
    expect(bumpedUids([
      { op: "update_text", uid: "u1", text: "a" },
      { op: "set_collapsed", uid: "u2", collapsed: true },
      { op: "update_text", uid: "u1", text: "ab" },
      { op: "set_heading", uid: "u3", heading: 1 },
      { op: "create_page", page_title: "P" },
    ])).toEqual(["u1", "u3"]);
  });

  test("is empty for a collapse-only batch", () => {
    expect(bumpedUids([{ op: "set_collapsed", uid: "u1", collapsed: false }]))
      .toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/outline/blockStamps.test.ts`
Expected: FAIL — "Failed to resolve import ./blockStamps".

- [ ] **Step 4: Write the module**

Create `web/src/outline/blockStamps.ts`:

```ts
// pattern: Functional Core
// Block timestamps in the page margin (bean pkm-4ler): which instant a row
// shows, which age band tints it, how it reads, and which ops count as a
// change. Clockless by construction -- "now" always arrives as an argument,
// so the reducer and the renderer can be tested without touching the clock.
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";

export type StampBand = "week" | "month" | "year" | "older";

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November",
                     "December"];

/** The instant a row displays: last change, falling back to creation.
 * created_at is a fallback for a missing updated_at, never a second column.
 * Null means the tree knows neither -- rendered as an empty cell, not an
 * omitted one, so the column stays a column. */
export function stampTs(
  node: Pick<BlockNode, "created_at" | "updated_at">,
): number | null {
  return node.updated_at ?? node.created_at ?? null;
}

/** Warm-for-fresh age bands. Inclusive upper edges: exactly 7 days old is
 * still "week". A future ts (clock skew between devices) lands in "week"
 * rather than wrapping round to "older". */
export function stampBand(nowMs: number, ts: number): StampBand {
  const ageDays = (nowMs - ts) / DAY_MS;
  if (ageDays <= 7) return "week";
  if (ageDays <= 31) return "month";
  if (ageDays <= 365) return "year";
  return "older";
}

/** "3 Aug 26" -- compact and precise; the band tint carries recency, so the
 * text carries what colour cannot. Local time: the user's own day is what a
 * peripheral cue is about. */
export function formatStamp(ts: number): string {
  const d = new Date(ts);
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${yy}`;
}

/** Hover precision for the cell's title attribute: "3 August 2026, 14:22". */
export function formatStampTitle(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`
    + `, ${hh}:${mm}`;
}

/** Does this op change its target block, in the sense pkm-r7k8 settled?
 * This is the same rule replica/localOps.ts applies when it writes
 * updated_at, kept here as one pure predicate so the replica's stored date
 * and the displayed date cannot drift apart. Notably set_collapsed is NOT a
 * change. delete and create_page bump no surviving block. */
export function opBumpsUpdatedAt(op: BlockOp): boolean {
  switch (op.op) {
    case "create":
    case "update_text":
    case "move":
    case "set_heading":
    case "set_view_type":
      return true;
    case "set_collapsed":
    case "delete":
    case "create_page":
      return false;
  }
}

/** The uids a batch marks as changed, in first-seen order and deduplicated.
 * Callers still have to check the uid survives in their own tree -- ops for
 * other pages and blocks the batch deleted must not be stamped. */
export function bumpedUids(ops: readonly BlockOp[]): string[] {
  const uids: string[] = [];
  for (const op of ops) {
    if (op.op === "create_page" || !opBumpsUpdatedAt(op)) continue;
    if (!uids.includes(op.uid)) uids.push(op.uid);
  }
  return uids;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/outline/blockStamps.test.ts && pnpm typecheck && pnpm check:fcis`
Expected: all blockStamps tests PASS; typecheck and FCIS clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/arthur/code/llm/pkm
git add web/src/outline/blockStamps.ts web/src/outline/blockStamps.test.ts .beans
git commit -m "feat(pkm-4ler): pure core for block stamp text, age bands, and which ops count as a change"
```

---

### Task 2: Keep the date honest while you edit

Today the in-memory tree's timestamps are only what the page load returned, so an edited block would show a stale date and a just-created block an empty cell. Both `local-ops` and `remote-ops` gain an `nowMs` supplied by `outlineSessions` (the shell that holds the clock); the reducer stamps `updated_at` on every changed uid that survives in this page's tree.

**Files:**
- Modify: `web/src/outline/outlineState.ts` (event union ~lines 37-47; `transitionOutline`'s `local-ops` branch ~161-177 and `remote-ops` branch ~181-187)
- Modify: `web/src/outline/outlineSessions.ts` (`applyLocal` ~line 696, `applyRemote` ~line 709)
- Modify: `web/src/outline/outlineState.test.ts` (7 existing event literals at lines 22, 57, 136, 202, 228, 232, 286 need the new field)
- Modify: `web/src/replica/localOps.test.ts` (drift guard)

**Interfaces:**
- Consumes: `bumpedUids` and `opBumpsUpdatedAt` from Task 1.
- Produces: `OutlineEvent`'s `local-ops` and `remote-ops` variants now **require** `nowMs: number`. Any future dispatch site must supply it; the type makes that non-optional on purpose.

- [ ] **Step 1: Write the failing reducer tests**

Append to `web/src/outline/outlineState.test.ts` (it already imports `block`, `transitionOutline`, `createOutlineState`, `findNode`):

```ts
describe("block stamps (pkm-4ler)", () => {
  const tree = () => [
    block("u1", "one", { order_idx: 0, created_at: 100, updated_at: 200 }),
    block("u2", "two", { order_idx: 1, created_at: 100, updated_at: 200,
      children: [block("u2c", "child", { created_at: 100, updated_at: 200 })] }),
  ];
  const NOW = 9_000_000;

  it("stamps the blocks a local batch changed and leaves the rest alone", () => {
    const state = transitionOutline(createOutlineState("Page", tree()), {
      type: "local-ops", ticketId: "w1", nowMs: NOW,
      ops: [{ op: "update_text", uid: "u2c", text: "edited" }],
    }).state;

    expect(findNode(state.blocks, "u2c")?.updated_at).toBe(NOW);
    expect(findNode(state.blocks, "u1")?.updated_at).toBe(200);
    expect(findNode(state.blocks, "u2")?.updated_at).toBe(200);
  });

  it("stamps a block the batch created, so a new row shows today", () => {
    const state = transitionOutline(createOutlineState("Page", tree()), {
      type: "local-ops", ticketId: "w1", nowMs: NOW,
      ops: [{ op: "create", uid: "u3", page_title: "Page", parent_uid: null,
              order_idx: 2, text: "fresh" }],
    }).state;

    expect(findNode(state.blocks, "u3")?.updated_at).toBe(NOW);
  });

  it("does not stamp for a collapse-only batch (pkm-r7k8)", () => {
    const state = transitionOutline(createOutlineState("Page", tree()), {
      type: "local-ops", ticketId: "w1", nowMs: NOW,
      ops: [{ op: "set_collapsed", uid: "u2", collapsed: true }],
    }).state;

    expect(findNode(state.blocks, "u2")?.updated_at).toBe(200);
    expect(findNode(state.blocks, "u2")?.collapsed).toBe(true);
  });

  it("stamps remote batches exactly as local ones", () => {
    const state = transitionOutline(createOutlineState("Page", tree()), {
      type: "remote-ops", nowMs: NOW,
      ops: [{ op: "set_heading", uid: "u1", heading: 2 }],
    }).state;

    expect(findNode(state.blocks, "u1")?.updated_at).toBe(NOW);
  });

  it("ignores ops for blocks that are not on this page or were deleted", () => {
    const state = transitionOutline(createOutlineState("Page", tree()), {
      type: "remote-ops", nowMs: NOW,
      ops: [
        { op: "update_text", uid: "elsewhere", text: "other page" },
        { op: "delete", uid: "u1" },
      ],
    }).state;

    expect(findNode(state.blocks, "u1")).toBeNull();
    expect(state.blocks.map((b) => b.uid)).toEqual(["u2"]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/outline/outlineState.test.ts`
Expected: FAIL — TypeScript rejects `nowMs` as an unknown property, and the stamping assertions report `200` where `9000000` was expected.

- [ ] **Step 3: Add `nowMs` to the two event variants**

In `web/src/outline/outlineState.ts`, edit the `OutlineEvent` union:

```ts
export type OutlineEvent =
  | { type: "local-ops"; ticketId: string; ops: readonly BlockOp[];
      nowMs: number }
  | { type: "local-tree"; blocks: BlockNode[] }
  | { type: "remote-ops"; ops: readonly BlockOp[]; nowMs: number }
```

(leave the remaining variants untouched).

- [ ] **Step 4: Stamp inside the reducer**

Add the import at the top of `outlineState.ts`, next to the existing `./tree` import:

```ts
import { bumpedUids } from "./blockStamps";
```

Add this helper just below the existing `replayActions` function:

```ts
/** Stamp updated_at on the blocks a batch changed (bean pkm-4ler). Runs on
 * the tree AFTER applyOps, so a uid the batch deleted, or an op aimed at
 * another page, is skipped simply by not being here. The clock arrives with
 * the event: this module stays pure, and a remote edit stamps exactly like a
 * local one because both flow through here. */
function stampBumped(blocks: BlockNode[], ops: readonly BlockOp[],
                     nowMs: number): BlockNode[] {
  const bumped = new Set(bumpedUids(ops));
  if (bumped.size === 0) return blocks;
  const walk = (nodes: BlockNode[]): BlockNode[] => nodes.map((n) => ({
    ...n,
    updated_at: bumped.has(n.uid) ? nowMs : n.updated_at,
    children: walk(n.children),
  }));
  return walk(blocks);
}
```

Then use it in both branches of `transitionOutline`:

```ts
  if (event.type === "local-ops") {
    const relevantWrites = new Set(state.relevantWrites);
    relevantWrites.add(event.ticketId);
    const relevantWriteReplays = new Map(state.relevantWriteReplays);
    relevantWriteReplays.set(event.ticketId, [{
      type: "ops", ops: [...event.ops],
    }]);
    const applied = stampBumped(
      applyOps(state.blocks, [...event.ops], state.title),
      event.ops, event.nowMs);
    return {
      state: {
        ...withBlocks(state, applied),
        relevantWrites,
        relevantWriteReplays,
      },
      effects: [],
    };
  }
```

```ts
  if (event.type === "remote-ops") {
    return {
      state: withBlocks(state, stampBumped(
        applyOps(state.blocks, [...event.ops], state.title),
        event.ops, event.nowMs)),
      effects: [],
    };
  }
```

- [ ] **Step 5: Supply the clock from the shell**

In `web/src/outline/outlineSessions.ts`, the two dispatch sites become:

```ts
    applyLocal: (ticket, ops) => {
      if (released) return;
      applyTransition(session, transitionOutline(session.state, {
        type: "local-ops", ticketId: ticket.id, ops, nowMs: Date.now(),
      }));
      trackWrite(session, ticket);
    },
```

```ts
      applyTransition(session, transitionOutline(session.state, {
        type: "remote-ops", ops: batch.ops, nowMs: Date.now(),
      }));
```

(`outlineSessions.ts` is `// pattern: Imperative Shell`, so owning the clock here is correct; `applyLocal`/`applyRemote`'s public signatures do not change.)

- [ ] **Step 6: Fix the seven pre-existing event literals**

In `web/src/outline/outlineState.test.ts`, add `nowMs: 0` to each existing `local-ops` / `remote-ops` literal (lines ~22, 57, 136, 202, 228, 232, 286 before your additions). `nowMs: 0` is deliberate: those tests assert causality, not dates, and a zero epoch keeps their block fixtures' `updated_at: 2000` visibly untouched only where nothing was bumped — so if one of them *does* start depending on stamping, it will say so loudly rather than silently agreeing.

- [ ] **Step 7: Run the outline suite**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/outline src/views src/components/EditableBlockTree.test.tsx`
Expected: PASS. If any pre-existing assertion deep-compares a whole tree after an edit, it will now see the stamped `updated_at`; fix it by asserting with `toMatchObject` on the fields that test actually cares about, never by removing the stamp.

- [ ] **Step 8: Add the replica drift guard**

The whole point of `opBumpsUpdatedAt` is that the displayed date and the replica's stored date cannot disagree. Append to `web/src/replica/localOps.test.ts`:

```ts
describe("opBumpsUpdatedAt agrees with what the replica actually writes (pkm-4ler)", () => {
  const ops: Array<[string, BlockOp]> = [
    ["update_text", { op: "update_text", uid: "uid_r1", text: "changed" }],
    ["move", { op: "move", uid: "uid_r1", parent_uid: null, order_idx: 5 }],
    ["set_heading", { op: "set_heading", uid: "uid_r1", heading: 2 }],
    ["set_view_type",
     { op: "set_view_type", uid: "uid_r1", view_type: "numbered" }],
    ["set_collapsed", { op: "set_collapsed", uid: "uid_r1", collapsed: true }],
  ];

  test.each(ops)("%s", (_label, op) => {
    t.db.exec("UPDATE blocks SET updated_at = 111 WHERE uid = 'uid_r1'");
    applyLocalOps(t.db, [op], 999);
    const after = blockRow("uid_r1").updated_at;
    expect(after === 999).toBe(opBumpsUpdatedAt(op));
  });
});
```

Add the import at the top of that file:

```ts
import { opBumpsUpdatedAt } from "../outline/blockStamps";
```

- [ ] **Step 9: Run the replica suite**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/replica/localOps.test.ts`
Expected: PASS (five cases; the `set_collapsed` row keeps `111`).

- [ ] **Step 10: Commit**

```bash
cd /Users/arthur/code/llm/pkm
git add web/src/outline/outlineState.ts web/src/outline/outlineState.test.ts \
        web/src/outline/outlineSessions.ts web/src/replica/localOps.test.ts
git commit -m "feat(pkm-4ler): stamp updated_at in the outline reducer from a shell-supplied clock"
```

---

### Task 3: The "Show timestamps" preference

One global preference, persisted to localStorage, default off, toggled from TopBar's `…` page menu and read by `PageView`. It travels through a context so both sides re-render together — two independent hook instances would visibly disagree until a route change.

**Files:**
- Create: `web/src/blockStampsPref.ts` (Functional Core: key, guard, toggle)
- Create: `web/src/blockStampsPref.test.ts`
- Create: `web/src/useBlockStampsPref.ts` (Imperative Shell: localStorage + state)
- Modify: `web/src/contexts.ts` (add `BlockStampsContext`)
- Modify: `web/src/App.tsx` (own the hook, provide the context)
- Modify: `web/src/components/TopBar.tsx` (the menu item)
- Modify: `web/src/components/TopBar.test.tsx`

**Interfaces:**
- Produces:
  - `blockStampsPref.ts`: `type BlockStampsPref = "on" | "off"`, `BLOCK_STAMPS_STORAGE_KEY = "pkm:block-stamps"`, `isBlockStampsPref(value: string | null | undefined): value is BlockStampsPref`, `toggleBlockStampsPref(current: BlockStampsPref): BlockStampsPref`
  - `useBlockStampsPref.ts`: `useBlockStampsPref(): { stamps: boolean; toggle: () => void }`
  - `contexts.ts`: `interface BlockStampsApi { stamps: boolean; toggle: () => void }` and `BlockStampsContext` with default `{ stamps: false, toggle: () => undefined }`
- Consumed by: Task 4 (`PageView` reads `BlockStampsContext`).

- [ ] **Step 1: Write the failing core test**

Create `web/src/blockStampsPref.test.ts` (mirror `src/sidebar.test.ts`'s shape):

```ts
import { expect, test } from "vitest";
import {
  BLOCK_STAMPS_STORAGE_KEY,
  isBlockStampsPref,
  toggleBlockStampsPref,
} from "./blockStampsPref";

test("the storage key is namespaced", () => {
  expect(BLOCK_STAMPS_STORAGE_KEY).toBe("pkm:block-stamps");
});

test("only the two known values are accepted", () => {
  expect(isBlockStampsPref("on")).toBe(true);
  expect(isBlockStampsPref("off")).toBe(true);
  expect(isBlockStampsPref("yes")).toBe(false);
  expect(isBlockStampsPref(null)).toBe(false);
  expect(isBlockStampsPref(undefined)).toBe(false);
});

test("toggling flips between the two", () => {
  expect(toggleBlockStampsPref("off")).toBe("on");
  expect(toggleBlockStampsPref("on")).toBe("off");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/blockStampsPref.test.ts`
Expected: FAIL — "Failed to resolve import ./blockStampsPref".

- [ ] **Step 3: Write the preference core and hook**

Create `web/src/blockStampsPref.ts`:

```ts
// pattern: Functional Core
// "Show timestamps" preference (bean pkm-4ler): whether main-pane pages
// render the block-stamp margin column. One global setting, not per page --
// it is peripheral awareness, and a per-page memory would make the column's
// absence look like missing data. Same shape as sidebar.ts: a bare string in
// localStorage, validated with a type guard.

export type BlockStampsPref = "on" | "off";

export const BLOCK_STAMPS_STORAGE_KEY = "pkm:block-stamps";

export function isBlockStampsPref(
  value: string | null | undefined,
): value is BlockStampsPref {
  return value === "on" || value === "off";
}

/** Flips the current value for a single toggle control. */
export function toggleBlockStampsPref(
  current: BlockStampsPref,
): BlockStampsPref {
  return current === "on" ? "off" : "on";
}
```

Create `web/src/useBlockStampsPref.ts`:

```ts
// pattern: Imperative Shell
import { useCallback, useEffect, useState } from "react";
import {
  BLOCK_STAMPS_STORAGE_KEY,
  isBlockStampsPref,
  toggleBlockStampsPref,
  type BlockStampsPref,
} from "./blockStampsPref";

function readStoredPref(): BlockStampsPref {
  try {
    const stored = localStorage.getItem(BLOCK_STAMPS_STORAGE_KEY);
    return isBlockStampsPref(stored) ? stored : "off";
  } catch {
    return "off"; // localStorage unavailable (private mode / disabled)
  }
}

function persistPref(pref: BlockStampsPref) {
  try {
    localStorage.setItem(BLOCK_STAMPS_STORAGE_KEY, pref);
  } catch {
    // Not persisted this session; the in-memory value still works.
  }
}

/** Whether main-pane pages show the block-stamp margin column, persisted
 * across reloads. App.tsx owns the single instance and shares it through
 * BlockStampsContext: two independent instances would not re-render each
 * other, so the TopBar checkmark and the column itself would disagree until
 * the next route change. */
export function useBlockStampsPref() {
  const [pref, setPref] = useState<BlockStampsPref>(readStoredPref);

  useEffect(() => {
    persistPref(pref);
  }, [pref]);

  const toggle = useCallback(() => setPref(toggleBlockStampsPref), []);

  return { stamps: pref === "on", toggle };
}
```

- [ ] **Step 4: Run the core test to verify it passes**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/blockStampsPref.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the context**

Append to `web/src/contexts.ts`:

```ts
/** Whether main-pane pages render the block-stamp margin column (pkm-4ler),
 * plus the toggle TopBar's page menu drives. One provider in App.tsx so the
 * menu's checkmark and PageView's column always agree. */
export interface BlockStampsApi {
  stamps: boolean;
  toggle: () => void;
}

export const BlockStampsContext = createContext<BlockStampsApi>({
  stamps: false,
  toggle: () => undefined,
});
```

- [ ] **Step 6: Provide it from App.tsx**

In `web/src/App.tsx`:

```ts
import { BlockStampsContext, SidebarContext } from "./contexts";
import { useBlockStampsPref } from "./useBlockStampsPref";
```

Inside `App()`, next to the existing `useSidebarCollapsed()` call:

```ts
  const { stamps, toggle: toggleStamps } = useBlockStampsPref();
  const blockStampsApi = useMemo(
    () => ({ stamps, toggle: toggleStamps }), [stamps, toggleStamps]);
```

Wrap the tree: put `<BlockStampsContext.Provider value={blockStampsApi}>` immediately inside `<SidebarContext.Provider …>` and close it immediately before that provider's closing tag (so it wraps `<div className="app-shell">` and everything under it, TopBar and the routes alike).

- [ ] **Step 7: Write the failing TopBar test**

Append to `web/src/components/TopBar.test.tsx`. Extend its existing `import { SidebarContext } from "../contexts";` line to `import { BlockStampsContext, SidebarContext } from "../contexts";` (do not add a second import of the same module). `renderTopBar` hardcodes its providers, so add a variant that also supplies the stamps context:

```ts
function renderTopBarWithStamps(stamps: boolean, toggle = vi.fn()) {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/AWS"]}>
      <BlockStampsContext.Provider value={{ stamps, toggle }}>
        <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
          <TopBar sidebarCollapsed={false} onToggleSidebar={vi.fn()} />
        </SidebarContext.Provider>
      </BlockStampsContext.Provider>
      <Routes>
        <Route path="/page/*" element={<p>page view here</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return { toggle };
}

it("offers a 'Show timestamps' checkbox item that reflects the preference", () => {
  renderTopBarWithStamps(false);
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  const item = screen.getByRole("menuitemcheckbox", { name: /Show timestamps/ });
  expect(item).toHaveAttribute("aria-checked", "false");
});

it("shows the item checked when the preference is on", () => {
  renderTopBarWithStamps(true);
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  expect(screen.getByRole("menuitemcheckbox", { name: /Show timestamps/ }))
    .toHaveAttribute("aria-checked", "true");
});

it("flipping the item toggles the preference and leaves the menu open", () => {
  const { toggle } = renderTopBarWithStamps(false);
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Show timestamps/ }));
  expect(toggle).toHaveBeenCalledTimes(1);
  // A checkbox item is a setting, not a destination: closing the menu on
  // every flip would make "try it and put it back" a four-click round trip.
  expect(screen.getByRole("menuitemcheckbox", { name: /Show timestamps/ }))
    .toBeInTheDocument();
});

it("does not offer the timestamps item off /page/* routes", () => {
  renderTopBar("/current-work");
  expect(screen.queryByRole("button", { name: "Page menu" })).toBeNull();
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/components/TopBar.test.tsx`
Expected: FAIL — no `menuitemcheckbox` named "Show timestamps".

- [ ] **Step 9: Add the menu item**

In `web/src/components/TopBar.tsx`, extend the context import and read the value:

```ts
import { BlockStampsContext, SidebarContext } from "../contexts";
```

```ts
  const { openInSidebar } = useContext(SidebarContext);
  const { stamps, toggle: toggleStamps } = useContext(BlockStampsContext);
```

Insert as the first `<li>` of the `role="menu"` list, above "Open in sidebar":

```tsx
              <li role="none">
                {/* A setting, not a destination: flipping it leaves the menu
                    open so the effect is visible behind it and a change of
                    mind is one more click, not four. Checkmark idiom matches
                    BlockMenu's (.block-menu-item-check). */}
                <button type="button" role="menuitemcheckbox"
                        aria-checked={stamps}
                        onClick={toggleStamps}>
                  <span className="top-bar-menu-check" aria-hidden="true">
                    {stamps ? "✓" : ""}
                  </span>
                  Show timestamps
                </button>
              </li>
```

- [ ] **Step 10: Run the TopBar and App suites**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/components/TopBar.test.tsx src/blockStampsPref.test.ts && pnpm typecheck && pnpm check:fcis && pnpm lint`
Expected: PASS / clean.

- [ ] **Step 11: Commit**

```bash
cd /Users/arthur/code/llm/pkm
git add web/src/blockStampsPref.ts web/src/blockStampsPref.test.ts \
        web/src/useBlockStampsPref.ts web/src/contexts.ts web/src/App.tsx \
        web/src/components/TopBar.tsx web/src/components/TopBar.test.tsx
git commit -m "feat(pkm-4ler): 'Show timestamps' page-menu preference, shared through a context"
```

---

### Task 4: The margin cell

The cell is the last flex child of `.block-row`, a sibling of both `.block-text` and the focused block's textarea — so focusing a row cannot shift it. The flag travels as a prop from `PageView` only; `EditableBlockTree` must **not** read the context itself, or the journal scroll and sidebar panels would get the column too.

**Files:**
- Modify: `web/src/components/EditableBlockTree.tsx` (`TreeProps`, the tree render, `EditableBlock`'s props and row)
- Modify: `web/src/views/EditablePage.tsx` (pass-through prop)
- Modify: `web/src/views/PageView.tsx` (read the context, pass the prop)
- Modify: `web/src/components/EditableBlockTree.test.tsx`
- Modify: `web/src/views/PageView.test.tsx`

**Interfaces:**
- Consumes: `stampTs`, `stampBand`, `formatStamp`, `formatStampTitle` (Task 1); `BlockStampsContext` (Task 3).
- Produces: `EditableBlockTree` gains `stamps?: boolean` (default `false`); `EditablePage` gains `stamps?: boolean` (default `false`). DOM contract other tasks and the E2E spec depend on: `<span class="block-stamp block-stamp-{band}" title="…">3 Aug 26</span>`, and for a block with neither timestamp `<span class="block-stamp" />` — present, empty, no band class, no title.

- [ ] **Step 1: Write the failing component tests**

Append to `web/src/components/EditableBlockTree.test.tsx` (it already has `handlers()` and imports `block`):

```ts
const DAY = 24 * 60 * 60 * 1000;

function mountStamped(blocks: BlockNode[], stamps: boolean) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={blocks} focus={null} handlers={handlers()}
                         readOnly={false} stamps={stamps} />
    </MemoryRouter>);
}
```

(add `import type { BlockNode } from "../api/payloads";` at the top if it is not already there)

```ts
test("renders no stamp column unless asked (journal and sidebar mounts)", () => {
  const view = mountStamped([block("s1", "text", { updated_at: Date.now() })],
                            false);
  expect(view.container.querySelector(".block-stamp")).toBeNull();
});

test("renders the stamp cell with the age band of updated_at", () => {
  const now = Date.now();
  const view = mountStamped([
    block("s1", "this week", { updated_at: now - 2 * DAY, order_idx: 0 }),
    block("s2", "this month", { updated_at: now - 20 * DAY, order_idx: 1 }),
    block("s3", "this year", { updated_at: now - 200 * DAY, order_idx: 2 }),
    block("s4", "ancient", { updated_at: now - 900 * DAY, order_idx: 3 }),
  ], true);
  const bandOf = (uid: string) =>
    view.container.querySelector(`[data-uid="${uid}"] .block-stamp`)?.className;

  expect(bandOf("s1")).toContain("block-stamp-week");
  expect(bandOf("s2")).toContain("block-stamp-month");
  expect(bandOf("s3")).toContain("block-stamp-year");
  expect(bandOf("s4")).toContain("block-stamp-older");
});

test("shows created_at when updated_at is missing, with a full hover title", () => {
  const created = new Date(2026, 7, 3, 14, 22).getTime();
  const view = mountStamped(
    [block("s1", "text", { created_at: created, updated_at: null })], true);
  const cell = view.container.querySelector(".block-stamp")!;

  expect(cell).toHaveTextContent("3 Aug 26");
  expect(cell).toHaveAttribute("title", "3 August 2026, 14:22");
});

test("keeps an empty cell when the block has no timestamps at all", () => {
  const view = mountStamped(
    [block("s1", "text", { created_at: null, updated_at: null })], true);
  const cell = view.container.querySelector(".block-stamp")!;

  // Present but blank: omitting it would let this row's text run wider than
  // its neighbours' and break the column.
  expect(cell).not.toBeNull();
  expect(cell.textContent).toBe("");
  expect(cell.className).toBe("block-stamp");
  expect(cell).not.toHaveAttribute("title");
});

test("stamps nested rows too, as the last child of their own row", () => {
  const now = Date.now();
  const view = mountStamped([block("p1", "parent", {
    updated_at: now,
    children: [block("c1", "child", { updated_at: now - 200 * DAY })],
  })], true);
  const childRow = view.container.querySelector('[data-uid="c1"]')!;

  expect(childRow.lastElementChild).toHaveClass("block-stamp");
  expect(childRow.lastElementChild).toHaveClass("block-stamp-year");
});

test("the stamp stays the row's last child while the block is focused", () => {
  const now = Date.now();
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[block("s1", "text", { updated_at: now })]}
                         focus={{ uid: "s1", cursor: 0 }} handlers={handlers()}
                         readOnly={false} stamps />
    </MemoryRouter>);
  const row = view.container.querySelector('[data-uid="s1"]')!;

  expect(row.querySelector("textarea")).not.toBeNull();
  expect(row.lastElementChild).toHaveClass("block-stamp");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/components/EditableBlockTree.test.tsx`
Expected: FAIL — `stamps` is not a known prop and `.block-stamp` is never found.

- [ ] **Step 3: Render the cell**

In `web/src/components/EditableBlockTree.tsx`, add the import:

```ts
import { formatStamp, formatStampTitle, stampBand,
         stampTs } from "../outline/blockStamps";
```

Extend `TreeProps`:

```ts
interface TreeProps {
  blocks: BlockNode[];
  focus: FocusTarget | null;
  // The live multi-block selection, if any. Optional so simple render sites
  // (and tests) that don't exercise selection can omit it.
  selection?: BlockSelection | null;
  handlers: OutlineHandlers;
  readOnly: boolean;
  fallback?: boolean;
  /** Render the last-changed margin column (bean pkm-4ler). A PROP, never a
   * context read: only PageView passes it, which is exactly what keeps the
   * journal scroll and sidebar panels bare. */
  stamps?: boolean;
}
```

Destructure it with a default and compute the clock once per render (this file is an Imperative Shell, so `Date.now()` belongs here rather than in the row):

```ts
export function EditableBlockTree({ blocks, focus, selection = null, handlers,
                                    readOnly, fallback = false,
                                    stamps = false }: TreeProps) {
```

```ts
  // One instant for the whole tree, so two rows a millisecond either side of
  // a band edge can't be tinted inconsistently within a single paint.
  const nowMs = Date.now();
```

Pass it down in the top-level map:

```tsx
        <EditableBlock key={b.uid} node={b} focus={focus} selected={selected}
                       handlers={handlers} readOnly={readOnly}
                       fallback={fallback} onRequestUpload={requestUpload}
                       viewMode="document" number={index + 1}
                       openMenuUid={menu?.uid ?? null}
                       stamps={stamps} nowMs={nowMs}
                       onOpenMenu={(uid, x, y, viewMode, trigger) =>
                         setMenu({ uid, x, y, viewMode, trigger })} />
```

Add a small render helper above `EditableBlock`:

```tsx
/** The margin cell: always rendered when the column is on, even with no
 * timestamp to show. A missing span would let that row's text claim the
 * gutter and break the column's alignment. */
function BlockStamp({ node, nowMs }: { node: BlockNode; nowMs: number }) {
  const ts = stampTs(node);
  if (ts === null) return <span className="block-stamp" />;
  return (
    <span className={`block-stamp block-stamp-${stampBand(nowMs, ts)}`}
          title={formatStampTitle(ts)}>
      {formatStamp(ts)}
    </span>
  );
}
```

Extend `EditableBlock`'s props and signature:

```ts
  openMenuUid: string | null;
  stamps: boolean;
  nowMs: number;
  onOpenMenu: (uid: string, x: number, y: number,
               viewMode: EffectiveBlockView, trigger: HTMLElement) => void;
```

```ts
function EditableBlock({ node, focus, selected, handlers, readOnly, fallback,
                         onRequestUpload, viewMode, number, openMenuUid,
                         stamps, nowMs, onOpenMenu }: {
```

Render it as the row's last child, immediately after the `{focused ? … : …}` block and before `</div>` closing `.block-row`:

```tsx
        {stamps && <BlockStamp node={node} nowMs={nowMs} />}
      </div>
```

And thread it through the recursion:

```tsx
            <EditableBlock key={c.uid} node={c} focus={focus} selected={selected}
                           handlers={handlers} readOnly={readOnly}
                           fallback={fallback} onRequestUpload={onRequestUpload}
                           viewMode={childrenView} number={index + 1}
                           openMenuUid={openMenuUid}
                           stamps={stamps} nowMs={nowMs}
                           onOpenMenu={onOpenMenu} />
```

- [ ] **Step 4: Run the component tests to verify they pass**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/components/EditableBlockTree.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing integration test**

Append to `web/src/views/PageView.test.tsx` (it already imports `Journal`, `EditableSidebarPanel`, `pagePayload`, `block`, `stubFetch`, `makeSync`, `SyncContext`, and defines `NoopIntersectionObserver`). Add `import { BlockStampsContext } from "../contexts";` to its existing imports:

```tsx
it("shows the stamp column on a page but not in the journal or a sidebar panel", async () => {
  const blocks = [block("uid_s1", "stamped", { updated_at: Date.now() })];
  stubFetch([
    ["/api/page/Stamps", pagePayload("Stamps", blocks)],
    ["/api/journal/cleanup", { deleted: [] }],
    ["/api/journal", { days: [{ date: "2026-08-03", title: "Stamps",
                               exists: true, blocks }] }],
  ]);
  vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
  const stampsOn = { stamps: true, toggle: vi.fn() };

  const page = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Stamps"]}>
      <SyncContext.Provider value={makeSync()}>
        <BlockStampsContext.Provider value={stampsOn}>
          <Routes><Route path="/page/*" element={<PageView />} /></Routes>
        </BlockStampsContext.Provider>
      </SyncContext.Provider>
    </MemoryRouter>,
  );
  expect(await screen.findByText("stamped")).toBeInTheDocument();
  expect(page.container.querySelector(".block-stamp")).not.toBeNull();
  page.unmount();

  // Same preference, same page: the sidebar panel and the journal scroll
  // mount EditablePage WITHOUT the flag, so they stay bare by construction.
  const panel = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={makeSync()}>
        <BlockStampsContext.Provider value={stampsOn}>
          <EditableSidebarPanel title="Stamps" />
        </BlockStampsContext.Provider>
      </SyncContext.Provider>
    </MemoryRouter>,
  );
  expect(await screen.findByText("stamped")).toBeInTheDocument();
  expect(panel.container.querySelector(".block-stamp")).toBeNull();
  panel.unmount();

  const journal = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={makeSync()}>
        <BlockStampsContext.Provider value={stampsOn}>
          <Journal />
        </BlockStampsContext.Provider>
      </SyncContext.Provider>
    </MemoryRouter>,
  );
  expect(await screen.findByText("stamped")).toBeInTheDocument();
  expect(journal.container.querySelector(".block-stamp")).toBeNull();
});
```

Each mount is unmounted before the next: a page has one outline session per title, and a second live mount would render the read-only fallback tree rather than the case under test.

- [ ] **Step 6: Run it to verify it fails**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/views/PageView.test.tsx`
Expected: FAIL — the page's `.block-stamp` is null (PageView does not pass the flag yet).

- [ ] **Step 7: Thread the flag through EditablePage and PageView**

In `web/src/views/EditablePage.tsx`:

```ts
export function EditablePage({ title, initial, composer = false,
                              stamps = false }: {
  title: string;
  initial: BlockNode[];
  composer?: boolean;
  /** Show the last-changed margin column (pkm-4ler). Only the main-pane
   * PageView passes this; the journal scroll and sidebar panels omit it. */
  stamps?: boolean;
}) {
```

and on the tree:

```tsx
        <EditableBlockTree blocks={outline.blocks} focus={outline.focus}
                           selection={outline.selection} handlers={handlers}
                           readOnly={outline.readOnly || !ownsEditor}
                           fallback={!ownsEditor} stamps={stamps} />
```

In `web/src/views/PageView.tsx`:

```ts
import { useContext } from "react"; // merge into the existing react import
import { BlockStampsContext } from "../contexts";
```

```ts
  const { stamps } = useContext(BlockStampsContext);
```

```tsx
        <EditablePage key={payload.page.title} title={payload.page.title}
                      initial={payload.blocks} composer stamps={stamps} />
```

- [ ] **Step 8: Run the view suites to verify they pass**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/views src/components/EditableBlockTree.test.tsx && pnpm typecheck && pnpm check:fcis && pnpm lint`
Expected: PASS / clean.

- [ ] **Step 9: Commit**

```bash
cd /Users/arthur/code/llm/pkm
git add web/src/components/EditableBlockTree.tsx \
        web/src/components/EditableBlockTree.test.tsx \
        web/src/views/EditablePage.tsx web/src/views/PageView.tsx \
        web/src/views/PageView.test.tsx
git commit -m "feat(pkm-4ler): render the block-stamp margin cell on main-pane pages"
```

---

### Task 5: Tokens and styles

Four age-band tokens in all three theme blocks, the `.block-stamp` geometry, the menu checkmark span, and the phone hide. Warm for fresh, fading to a barely-there cool tint for old — the strongest colour lands on the rare recent rows, so a page of old material reads as almost untinted.

**Files:**
- Modify: `web/src/styles.css`
- Modify: `web/src/styles.test.ts`

**Interfaces:**
- Consumes: the class names Task 4 renders (`.block-stamp`, `.block-stamp-week|-month|-year|-older`) and Task 3's `.top-bar-menu-check`.
- Produces: `--color-stamp-week`, `--color-stamp-month`, `--color-stamp-year`, `--color-stamp-older`.

- [ ] **Step 1: Write the failing style tests**

Append to `web/src/styles.test.ts` (it already defines `ruleFor`, `rulesFor`, `mediaRulesFor`):

```ts
describe("block stamps (pkm-4ler)", () => {
  const BANDS = ["week", "month", "year", "older"] as const;

  test("the four age-band tokens exist in all three theme blocks", () => {
    const blocks = [
      ruleFor(":root"),
      ruleFor(':root:not([data-theme="light"])'),
      ruleFor(':root[data-theme="dark"]'),
    ];
    for (const body of blocks) {
      for (const band of BANDS) {
        expect(body).toMatch(new RegExp(`--color-stamp-${band}: #[0-9a-fA-F]{6};`));
      }
    }
  });

  test("light and dark values differ for every band", () => {
    const light = ruleFor(":root");
    const dark = ruleFor(':root[data-theme="dark"]');
    for (const band of BANDS) {
      const pattern = new RegExp(`--color-stamp-${band}: (#[0-9a-fA-F]{6});`);
      expect(light.match(pattern)?.[1]).not.toBe(dark.match(pattern)?.[1]);
    }
  });

  test("each band class fills with its own token", () => {
    for (const band of BANDS) {
      expect(rulesFor(`.block-stamp-${band}`))
        .toContain(`background: var(--color-stamp-${band});`);
    }
  });

  test("the cell is a fixed-width right-aligned column that never wraps", () => {
    const body = rulesFor(".block-stamp");
    // Fixed width, not content width: the stamps must form a true column
    // rather than tracking each row's text length.
    expect(body).toMatch(/flex: 0 0 \d+px;/);
    expect(body).toContain("text-align: right;");
    expect(body).toContain("white-space: nowrap;");
  });

  test("the column is hidden on phones", () => {
    expect(mediaRulesFor("(max-width: 600px)", ".block-stamp"))
      .toContain("display: none;");
  });

  test("the page-menu checkmark reserves its width like BlockMenu's", () => {
    expect(rulesFor(".top-bar-menu-check")).toContain("display: inline-block;");
    expect(rulesFor(".top-bar-menu-check")).toContain("width: 1.25em;");
  });
});
```

Note on the first test: `ruleFor(':root:not([data-theme="light"])')` reaches the OS-dark theme block even though it sits inside `@media (prefers-color-scheme: dark)` — `ruleFor` scans the whole file and that selector's own body contains no nested rule, so its `[^}]*` match ends at the right brace. Plain `ruleFor(":root")` cannot accidentally match it either: the regex demands `{` straight after `:root`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/styles.test.ts`
Expected: FAIL — missing tokens and "Missing CSS rule for .block-stamp".

- [ ] **Step 3: Add the tokens**

In `web/src/styles.css`, add to `:root` (after the `--color-bullet-ring: #c6d7e3;` line):

```css
  /* block stamp bands (pkm-4ler): warm for fresh, cooling to a barely-there
   * tint for old. The strongest colour lands on the rare recent rows, so a
   * page of entirely old material reads as almost untinted. Solid fills, not
   * alpha, so they stay predictable over .block-row:hover and .focused. */
  --color-stamp-week: #f7c9a6;
  --color-stamp-month: #fae3cf;
  --color-stamp-year: #e4ebf1;
  --color-stamp-older: #f1f4f7;
```

Add to **both** dark blocks (`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` and `:root[data-theme="dark"]`), after each one's `--color-bullet-ring: #4a5866;`:

```css
    /* a notch less saturated than the light warms, so they read as tint
     * rather than brown */
    --color-stamp-week: #4d3526;
    --color-stamp-month: #38302a;
    --color-stamp-year: #2b333a;
    --color-stamp-older: #252b31;
```

(match each block's own indentation — 4 spaces inside the media query, 2 in `:root[data-theme="dark"]`.)

- [ ] **Step 4: Add the cell styles**

In the `/* outline */` section, immediately after the `.block-text.quote-block { … }` rule:

```css
/* Last-changed margin column (pkm-4ler). Lives INSIDE .block-row, after
 * .block-text and after the focused row's textarea, which is what makes the
 * column align across every nesting depth (.block-children indents from the
 * left only) and what stops the cell shifting when a row gains focus.
 * .block-text is flex:1, so the text column gives up exactly this width --
 * no --pane-width or .main-pane change is needed. */
.block-stamp { flex: 0 0 56px; margin-left: 10px; padding: 0 4px;
  border-radius: var(--radius-control); font-size: 11px; text-align: right;
  white-space: nowrap; color: var(--color-text-muted); background: none;
  user-select: none; }
.block-stamp-week { background: var(--color-stamp-week); }
.block-stamp-month { background: var(--color-stamp-month); }
.block-stamp-year { background: var(--color-stamp-year); }
.block-stamp-older { background: var(--color-stamp-older); }
```

Next to the `.top-bar-menu button, .top-bar-menu a { … }` rules, add:

```css
/* Same reserved-width checkmark idiom as BlockMenu's .block-menu-item-check,
 * so a checked and an unchecked item keep their labels on one line. */
.top-bar-menu-check { display: inline-block; width: 1.25em; }
```

In the existing `@media (max-width: 600px)` phone block, add:

```css
  /* A ~68px gutter is too much of a phone line, and the page-menu toggle is
   * a desktop affordance (pkm-4ler). */
  .block-stamp { display: none; }
```

- [ ] **Step 5: Run the style tests to verify they pass**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm vitest run src/styles.test.ts`
Expected: PASS.

- [ ] **Step 6: Look at it in the running app**

The token values are starting points, to be trimmed by eye. Build and drive the real UI (never port 8974):

```bash
cd /Users/arthur/code/llm/pkm/web && PKM_API_PORT=8975 pnpm dev
```

Open a long page, turn the preference on from the `…` menu, and check both themes: the week band should read as a warm tint and the `older` band as nearly invisible; `.block-row:hover` and a focused row must not make any band look like a selection. Adjust the eight hex values if needed (the tests pin the token *names* and that light ≠ dark, not the exact values). Report the final values in the commit message if you change them.

- [ ] **Step 7: Commit**

```bash
cd /Users/arthur/code/llm/pkm
git add web/src/styles.css web/src/styles.test.ts
git commit -m "feat(pkm-4ler): age-band tokens and the block-stamp column styles"
```

---

### Task 6: End-to-end pass

One Playwright spec: the toggle turns the column on, a real date is visible on a real page, and the preference survives a reload.

**Files:**
- Create: `web/e2e/block-stamps.spec.ts`

**Interfaces:**
- Consumes: the `.block-stamp` DOM contract from Task 4 and the "Show timestamps" `menuitemcheckbox` from Task 3.

- [ ] **Step 1: Write the spec**

Create `web/e2e/block-stamps.spec.ts`:

```ts
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

/** Creates a uniquely-named page via POST (never writes to today's journal,
 * which other specs assume stays empty) and navigates to it. */
async function createAndVisitPage(page: Page, title: string) {
  const createRes = await page.request.post("/api/pages", { data: { title } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await expect(page.locator("h1.page-title")).toHaveText(title);
}

async function toggleStamps(page: Page) {
  await page.getByRole("button", { name: "Page menu" }).click();
  await page.getByRole("menuitemcheckbox", { name: /Show timestamps/ }).click();
  await page.keyboard.press("Escape");
}

test("the page menu toggles a stamp column that survives a reload", async ({ page }) => {
  const title = `BlockStamps${Date.now()}`;
  await login(page);
  await createAndVisitPage(page, title);

  // A block to stamp: type one into the freshly created (empty) page.
  await page.getByText("Click to start writing…").click();
  await page.locator("textarea.block-input").fill("a block with a date");
  await expect(page.locator(".block-row")).toHaveCount(1);

  // Off by default.
  await expect(page.locator(".block-stamp")).toHaveCount(0);

  await toggleStamps(page);
  const stamp = page.locator(".block-stamp").first();
  await expect(stamp).toBeVisible();
  // Just created, so it lands in the freshest band with a real date on it.
  await expect(stamp).toHaveClass(/block-stamp-week/);
  await expect(stamp).toHaveText(/^\d{1,2} [A-Z][a-z]{2} \d{2}$/);

  await page.reload();
  await expect(page.locator("h1.page-title")).toHaveText(title);
  await expect(page.locator(".block-stamp").first()).toBeVisible();

  // The menu item reflects the stored preference after the reload.
  await page.getByRole("button", { name: "Page menu" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: /Show timestamps/ }))
    .toHaveAttribute("aria-checked", "true");
});
```

- [ ] **Step 2: Run it**

Run: `cd /Users/arthur/code/llm/pkm/web && pnpm build && npx playwright test e2e/block-stamps.spec.ts`
Expected: PASS. `pnpm build` first is mandatory — Playwright serves the built bundle, so an unbuilt change silently tests the previous code.

Two failure modes worth recognising rather than papering over: a stamp cell that renders but is empty means the reducer is not stamping locally created blocks (Task 2, Step 4); a stamp that disappears after reload means the preference is not persisting (Task 3's hook) — check `localStorage["pkm:block-stamps"]` in the browser rather than relaxing the assertion.

- [ ] **Step 3: Commit**

```bash
cd /Users/arthur/code/llm/pkm
git add web/e2e/block-stamps.spec.ts
git commit -m "test(pkm-4ler): e2e pass for the stamp column toggle and its persistence"
```

---

### Task 7: Architecture docs, full gates, and bean close

**Files:**
- Modify: `docs/architecture/frontend.md` (module map ~line 32-95; "Styling and theming" ~line 500; a prose note in "The editor" ~line 226)
- Modify: `.beans/pkm-4ler--expose-block-createdlast-changed-timestamps-in-the.md`

- [ ] **Step 1: Update the module map**

In `docs/architecture/frontend.md`, in the `outline/` entry's "Cores:" list, add `blockStamps.ts` with a one-clause gloss:

```
                       Cores: outlineState.ts (the reducer), keyboardPolicy.ts,
                       edits.ts, tree.ts (applyOps — mirrors server ops_apply),
                       keyEdits.ts, slashCommands.ts, autocomplete.ts,
                       refAtCaret.ts, blockSelection.ts, history.ts,
                       paste.ts (outline paste), calendar.ts (/date month grid),
                       missingPage.ts (the missing-page policy),
                       blockStamps.ts (margin-column dates, age bands, and
                       which ops count as a change)
```

And in the top-level list, next to `routeMeta.ts`, add the preference pair:

```
blockStampsPref.ts     Core    "Show timestamps" preference (localStorage key +
                               guard + toggle); useBlockStampsPref.ts (Shell)
                               owns the single instance, shared through
                               BlockStampsContext so TopBar's checkmark and
                               PageView's column cannot disagree
```

Also update the `main.tsx / App.tsx` line so the provider chain names the new context:
`SidebarContext > BlockStampsContext > (left nav, TopBar, routes, sidebar stack)`.

- [ ] **Step 2: Add the styling entries**

In "Styling and theming", after the radius table, add:

```markdown
Block stamps (pkm-4ler) add four band tokens — `--color-stamp-week`,
`-month`, `-year`, `-older` — declared in all three theme blocks. They run
warm-for-fresh to a barely-there cool tint for old, deliberately: the
strongest colour then lands on the rare recent rows, and a page of entirely
old material reads as almost untinted. They are solid fills, not alpha, so a
band stays predictable over `.block-row:hover` and `.block-row.focused`.
`.block-stamp` is the control class; below the 600px breakpoint the whole
column is `display: none`.
```

- [ ] **Step 3: Add the two invariant notes**

In "The editor", add a short prose note (the highest-value kind of doc update — someone could break either of these without noticing):

```markdown
**The stamp cell lives inside `.block-row`.** It is the row's last flex child,
after `.block-text` or, when the block is focused, after `BlockInput`'s
textarea. Both facts are load-bearing: `.block-children` indents from the left
only, so every row in a page already shares a right edge and the cells form a
true column at any nesting depth; and because the cell is a sibling of the
textarea rather than of the row, focusing a block cannot shift it. The flag
reaches it as a **prop** from `PageView` alone — `EditableBlockTree` must never
read `BlockStampsContext` itself, or the journal scroll and sidebar panels
would grow the column too.

**`set_collapsed` must not stamp.** `opBumpsUpdatedAt` (outline/blockStamps.ts)
is the single statement of pkm-r7k8's rule that collapsing is a view toggle,
not a change. `transitionOutline` uses it to decide which uids to stamp, and a
test in `replica/localOps.test.ts` asserts the replica's own writes agree
op-for-op — so the displayed date and the stored date cannot drift apart.
```

- [ ] **Step 4: Run the full gates**

```bash
cd /Users/arthur/code/llm/pkm/server && uv run pytest -q
cd /Users/arthur/code/llm/pkm/server && uv run pyrefly check
cd /Users/arthur/code/llm/pkm/server && uv run ruff check
cd /Users/arthur/code/llm/pkm/web && pnpm verify
```

Expected: all green, including the enforced coverage thresholds. If coverage dips, the gap is a missing test for a new branch — add it; do not lower a threshold.

- [ ] **Step 5: Close the bean**

```bash
cd /Users/arthur/code/llm/pkm
beans update --json pkm-4ler -s completed --body-append "$(cat <<'EOF'

## Summary of Changes

Blocks on main-pane pages show their last-changed date in a fixed-width right
margin column, tinted by age, behind a "Show timestamps" item in the page menu
(global, localStorage-backed, default off).

- `outline/blockStamps.ts` (Core): stampTs (updated_at ?? created_at),
  stampBand (week/month/year/older), formatStamp, formatStampTitle,
  opBumpsUpdatedAt, bumpedUids.
- `transitionOutline` stamps updated_at on the uids a batch changed, from an
  nowMs supplied by outlineSessions -- so an edited row's date is honest
  without a reload, and remote edits stamp exactly like local ones.
- Preference: blockStampsPref.ts (Core) + useBlockStampsPref.ts (Shell) +
  BlockStampsContext, provided by App.tsx.
- The column is a PROP from PageView only: journal and sidebar stay bare.
- Four --color-stamp-* tokens in all three theme blocks; hidden below 600px.
- Docs: frontend.md module map, styling section, and two invariant notes.

Out of scope (as designed): bullet hover tooltips, a block-menu info entry,
recency search/filter, stamps on search results or backlinks, and surfacing
which created_at values are pkm-r7k8 page-level approximations.
EOF
)"
```

Then tick the checklist items added in Task 1 (`beans update pkm-4ler --body-replace-old "- [ ] Task 1" --body-replace-new "- [x] Task 1"`, and so on for each).

- [ ] **Step 6: Commit**

```bash
cd /Users/arthur/code/llm/pkm
git add docs/architecture/frontend.md .beans
git commit -m "docs(pkm-4ler): document the stamp column, its tokens, and its two invariants"
```

- [ ] **Step 7: Hand back for integration**

Do not merge. Report completion with the gate output, and use `superpowers:finishing-a-development-branch` to decide how `pkm-4ler-block-timestamps` gets integrated (project convention: `git merge --no-ff`).

---

## Notes for the implementer

- **Why `nowMs` is required, not optional.** Making the field optional would let a future dispatch site silently skip stamping and leave dates stale in exactly the way this change exists to fix. Seven existing test literals need `nowMs: 0`; that is the whole cost.
- **Why stamping happens after `applyOps`, not inside it.** `applyOps` mirrors the server's `ops_apply.py` exactly and is shared with replay paths; putting a clock-derived write inside it would make replay non-idempotent. Stamping the applied tree also gives the "uid survived this batch" filter for free.
- **What the server does not do.** No server, schema, or API change is in scope. `BlockNode.created_at`/`updated_at` already reach the client through `/api/page/{title}`.
