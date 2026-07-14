# Journal Hide Nonexistent Days Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide non-existent past daily pages in the Journal while preserving today's composer and pagination behavior.

**Architecture:** Keep `/api/journal` unchanged and continue storing every fetched day in `daysRef`/`days` so `before=` pagination and empty-batch detection remain based on the server window. Filter only at render time: render a day when it exists or when it is the first loaded day, because the first day is today by construction and must remain editable for composing.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library.

## Global Constraints

- Do not change server API shape or pagination semantics.
- Keep `web/src/views/Journal.tsx` marked `// pattern: Imperative Shell`.
- Use TDD: add a failing Vitest assertion before changing production code.
- Today's first loaded Journal day remains visible even if `exists: false`.
- Non-existent older/past days are not displayed and do not expose composers.

---

### Task 1: Render only existing days plus today

**Files:**
- Modify: `web/src/views/Journal.test.tsx`
- Modify: `web/src/views/Journal.tsx`

**Interfaces:**
- Consumes: `JournalDay.exists: boolean` from `web/src/api/payloads`.
- Produces: render-time behavior where `days.map(...)` is filtered by `(day.exists || index === 0)`.

- [ ] **Step 1: Write the failing test**

In `web/src/views/Journal.test.tsx`, update `renders the first batch newest-first and loads older days on intersect` so it asserts that non-existent past days from both the initial and older batches are absent, while existing days still render and only existing days plus today's day expose composers:

```ts
  expect(screen.queryByRole("link", { name: "July 7th, 2026" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "July 5th, 2026" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /start writing/i }).length).toBe(3);
```

After loading the older batch, add:

```ts
  expect(screen.queryByRole("link", { name: "July 2nd, 2026" })).not.toBeInTheDocument();
```

Add a new test to pin the today exception:

```ts
it("keeps today visible for composing even when its page does not exist yet", async () => {
  stubFetch([
    ["/api/journal?days=5", { days: [
      day("2026-07-08", "July 8th, 2026", [], false),
      day("2026-07-07", "July 7th, 2026", [], false),
    ] }],
  ]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>);

  expect(await screen.findByRole("link", { name: "July 8th, 2026" }))
    .toHaveAttribute("href", "/page/July%208th%2C%202026");
  expect(screen.getByRole("button", { name: /start writing/i })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "July 7th, 2026" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm test:unit src/views/Journal.test.tsx`

Expected: FAIL because `July 7th, 2026`, `July 5th, 2026`, and `July 2nd, 2026` are still rendered.

- [ ] **Step 3: Write minimal implementation**

In `web/src/views/Journal.tsx`, filter only the render loop:

```tsx
        {days.map((day, i) => ({ day, i }))
          .filter(({ day, i }) => day.exists || i === 0)
          .map(({ day, i }) => (
          <section className="journal-day" key={day.date}>
            <h1 className="page-title">
              <Link to={pagePath(day.title)}>{day.title}</Link>
            </h1>
            {/* the first loaded day is today by construction */}
            <EditablePage title={day.title} initial={day.blocks}
                          composer={i === 0} />
          </section>
        ))}
```

- [ ] **Step 4: Run targeted tests to verify green**

Run: `cd web && pnpm test:unit src/views/Journal.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run web verification**

Run: `cd web && pnpm verify`

Expected: typecheck, coverage, and Playwright e2e pass.

- [ ] **Step 6: Update bean, commit, and push**

Update `.beans/pkm-zws4--journal-consider-not-rendering-days-whose-page-doe.md` with checked plan items and a summary. Commit code, plan, and bean:

```bash
git add web/src/views/Journal.tsx web/src/views/Journal.test.tsx docs/superpowers/plans/2026-07-14-journal-hide-nonexistent-days.md .beans/pkm-zws4--journal-consider-not-rendering-days-whose-page-doe.md
git commit -m "Hide nonexistent past days in journal"
git push -u origin pkm-zws4
```

Expected: commit succeeds and branch is pushed.

## Self-review

- Spec coverage: frontend-only render filtering, today exception, pagination preservation, and tests are covered by Task 1.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: uses existing `JournalDay.exists` and React render loop variables `day`/`i` consistently.
