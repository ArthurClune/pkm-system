# Enter Block Insertion Regression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale same-page refetches from replacing an optimistic Enter/split result before the local op queue is idle.

**Architecture:** `EditablePage` remains the shell rendering an outline. `useOutline` owns local optimistic state and will treat incoming `initial` props as authoritative only when no locally-enqueued write is outstanding.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library.

## Global Constraints

- Preserve FCIS pattern comments; `useOutline.ts` is an Imperative Shell.
- Use TDD: add the regression test and verify it fails before production code changes.
- No broad editor refactor; make the smallest state-adoption change that fixes the regression.

---

### Task 1: Guard stale initial adoption during local writes

**Files:**
- Modify: `web/src/views/EditablePage.test.tsx`
- Modify: `web/src/outline/useOutline.ts`

**Interfaces:**
- Consumes: `Sync.idle(): Promise<void>` from `web/src/sync/SyncProvider.tsx`.
- Produces: unchanged `useOutline(pageTitle, initial): Outline` API.

- [ ] **Step 1: Write the failing test**

Add a test that renders `EditablePage`, performs an Enter split, then rerenders the same page title with a fresh copy of the old `initial` blocks while `sync.idle()` has not resolved. Assert the new empty textarea remains focused.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm test:unit -- --run src/views/EditablePage.test.tsx`
Expected: the new regression test fails because `useOutline` adopts the stale old `initial` and removes the optimistic empty block.

- [ ] **Step 3: Write minimal implementation**

In `useOutline.ts`, track a local outstanding write counter/ref. Increment when `run()` enqueues non-empty ops, decrement after `sync.idle()` settles. In the `initial` adoption effect, if local writes are outstanding, ignore that same-page `initial` update instead of calling `setBlocks(initial)`.

- [ ] **Step 4: Run focused tests**

Run: `cd web && pnpm test:unit -- --run src/views/EditablePage.test.tsx src/outline/useOutline.dnd.test.tsx src/components/EditableBlockTree.test.tsx`
Expected: all focused tests pass.

- [ ] **Step 5: Browser verify**

Build and run the scratch server. In agent-browser, create/open a page, type a block, press Enter, and assert the focused textarea is empty with two block rows.
