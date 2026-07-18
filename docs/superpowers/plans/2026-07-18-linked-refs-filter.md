# Linked References Filter Implementation Plan (pkm-m4an)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roam-style filter for the "Linked references" section — chips for every page/tag co-referenced in the backlinks; click to filter-for, shift-click to filter-out.

**Architecture:** Fully client-side (no server/API changes). A functional-core module (`backlinkFilter.ts`) turns loaded backlink groups + filter state into visible groups and chip counts, reusing `grammar/refs.ts` `extractRefs` (fixture-pinned mirror of the server's `refs.py`). The imperative shell (`BacklinksSection.tsx`) loads **all** backlinks when the filter panel opens (looping the existing `bl_offset` pagination with `bl_limit=100`) so chips and counts never lie about unloaded pages.

**Tech Stack:** React + TypeScript, vitest + @testing-library/react, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-18-linked-refs-filter-design.md`

## Global Constraints

- Work in a worktree branch (e.g. `feature/linked-refs-filter`), created via superpowers:using-git-worktrees at execution start. Run every command from the worktree root; check `git status -sb` before every commit (parallel sessions exist).
- FCIS: new logic file declares `// pattern: Functional Core`; the component stays `// pattern: Imperative Shell`.
- Filter semantics (from spec): item's ref set = refs of its own text ∪ refs of every breadcrumb string; item visible ⇔ contains ALL includes and NO excludes; group visible ⇔ ≥1 visible item; chips merge kinds (`#Paper`/`[[Paper]]`/`Paper::` = one chip per title); the current page's own title is never a chip; chip counts recompute over the currently visible set; filter state is ephemeral component state.
- No server changes; do not touch `server/` or regenerate openapi types.
- Verification command for web work: `cd web && pnpm verify` (typecheck, lint, fcis, unit coverage, build, Playwright).

---

### Task 1: Functional core — `backlinkFilter.ts`

**Files:**
- Create: `web/src/components/backlinkFilter.ts`
- Test: `web/src/components/backlinkFilter.test.ts`

**Interfaces:**
- Consumes: `extractRefs(text: string): ParsedRefs` from `web/src/grammar/refs.ts` (`.refs` is `{title: string, kind: "link"|"tag"|"attribute"}[]`); types `BacklinkGroup`, `BacklinkItem` from `web/src/api/payloads.ts` (`BacklinkItem = {uid: string, text: string, breadcrumbs: string[]}`).
- Produces (used by Task 2):
  - `interface FilterState { include: string[]; exclude: string[] }`
  - `const EMPTY_FILTER: FilterState`
  - `isFiltering(f: FilterState): boolean`
  - `itemRefTitles(item: BacklinkItem): ReadonlySet<string>`
  - `applyFilter(groups: BacklinkGroup[], f: FilterState): BacklinkGroup[]`
  - `interface Chip { title: string; count: number }`
  - `chipCounts(visible: BacklinkGroup[], omit: Iterable<string>): Chip[]`
  - `toggleChip(f: FilterState, title: string, side: "include" | "exclude"): FilterState`

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/backlinkFilter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BacklinkGroup } from "../api/payloads";
import { applyFilter, chipCounts, EMPTY_FILTER, isFiltering, itemRefTitles,
         toggleChip } from "./backlinkFilter";

const item = (uid: string, text: string, breadcrumbs: string[] = []) =>
  ({ uid, text, breadcrumbs });

const groups: BacklinkGroup[] = [
  { page_id: 1, page_title: "Daily A", items: [
    item("u1", "alpha [[Claude]] #Paper"),
    item("u2", "beta [[Claude]] #Idea")] },
  { page_id: 2, page_title: "Daily B", items: [
    item("u3", "gamma [[Claude]]", ["reading list #Paper"])] },
];

describe("itemRefTitles", () => {
  it("collects titles from text and breadcrumb ancestors", () => {
    const refs = itemRefTitles(item("u3", "gamma [[Claude]]", ["reading #Paper"]));
    expect(refs).toEqual(new Set(["Claude", "Paper"]));
  });

  it("merges link, tag and attribute forms of the same title", () => {
    const refs = itemRefTitles(item("u9", "[[Paper]] #Paper Paper:: x #[[Constitutional AI]]"));
    expect(refs).toEqual(new Set(["Paper", "Constitutional AI"]));
  });
});

describe("applyFilter", () => {
  it("returns groups untouched for the empty filter", () => {
    expect(applyFilter(groups, EMPTY_FILTER)).toBe(groups);
    expect(isFiltering(EMPTY_FILTER)).toBe(false);
  });

  it("include keeps only items referencing ALL included titles", () => {
    const out = applyFilter(groups, { include: ["Paper"], exclude: [] });
    expect(out.map((g) => g.items.map((i) => i.uid))).toEqual([["u1"], ["u3"]]);
    const both = applyFilter(groups, { include: ["Paper", "Idea"], exclude: [] });
    expect(both).toEqual([]); // no single item carries both
  });

  it("exclude hides items (breadcrumb refs count) and drops empty groups", () => {
    const out = applyFilter(groups, { include: [], exclude: ["Paper"] });
    // u1 excluded by own text, u3 by ancestor; Daily B disappears entirely
    expect(out.map((g) => g.items.map((i) => i.uid))).toEqual([["u2"]]);
  });
});

describe("chipCounts", () => {
  it("counts items per title, omitting the given titles, sorted by count then title", () => {
    expect(chipCounts(groups, ["Claude"])).toEqual([
      { title: "Paper", count: 2 },
      { title: "Idea", count: 1 },
    ]);
  });

  it("ties break alphabetically", () => {
    const g: BacklinkGroup[] = [{ page_id: 1, page_title: "X", items: [
      item("u1", "#zebra #apple")] }];
    expect(chipCounts(g, [])).toEqual([
      { title: "apple", count: 1 }, { title: "zebra", count: 1 }]);
  });
});

describe("toggleChip", () => {
  it("adds, clears on re-toggle, and moves between sides", () => {
    const inc = toggleChip(EMPTY_FILTER, "Paper", "include");
    expect(inc).toEqual({ include: ["Paper"], exclude: [] });
    expect(toggleChip(inc, "Paper", "include")).toEqual(EMPTY_FILTER);
    const moved = toggleChip(inc, "Paper", "exclude");
    expect(moved).toEqual({ include: [], exclude: ["Paper"] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm vitest run src/components/backlinkFilter.test.ts`
Expected: FAIL — module `./backlinkFilter` not found.

- [ ] **Step 3: Implement the module**

Create `web/src/components/backlinkFilter.ts`:

```ts
// pattern: Functional Core
// Linked-references filtering (pkm-m4an): pure functions from loaded
// backlink groups + filter state to visible groups and candidate chips.
// Ref extraction reuses grammar/refs.ts, the fixture-pinned mirror of the
// server's refs.py, so chips agree with what the server indexes.

import type { BacklinkGroup, BacklinkItem } from "../api/payloads";
import { extractRefs } from "../grammar/refs";

export interface FilterState {
  include: string[];
  exclude: string[];
}

export const EMPTY_FILTER: FilterState = { include: [], exclude: [] };

export function isFiltering(f: FilterState): boolean {
  return f.include.length > 0 || f.exclude.length > 0;
}

// mergeGroups copies group objects but reuses item objects across
// pagination batches, so a WeakMap keyed by item survives load-all merges.
const refCache = new WeakMap<BacklinkItem, ReadonlySet<string>>();

/** Every page title the item references in its own text or any ancestor
 * (breadcrumb) block: a block nested under "Papers to read #Paper" counts
 * as tagged Paper. Kinds merge: #X, [[X]] and X:: are all just "X". */
export function itemRefTitles(item: BacklinkItem): ReadonlySet<string> {
  const hit = refCache.get(item);
  if (hit) return hit;
  const titles = new Set<string>();
  for (const text of [item.text, ...item.breadcrumbs]) {
    for (const r of extractRefs(text).refs) titles.add(r.title);
  }
  refCache.set(item, titles);
  return titles;
}

/** Item visible = references ALL includes and NONE of the excludes;
 * groups left with no visible items disappear. */
export function applyFilter(groups: BacklinkGroup[], f: FilterState): BacklinkGroup[] {
  if (!isFiltering(f)) return groups;
  const out: BacklinkGroup[] = [];
  for (const g of groups) {
    const items = g.items.filter((it) => {
      const refs = itemRefTitles(it);
      return f.include.every((t) => refs.has(t)) &&
             !f.exclude.some((t) => refs.has(t));
    });
    if (items.length > 0) out.push({ ...g, items });
  }
  return out;
}

export interface Chip {
  title: string;
  count: number;
}

/** Candidate chips over the *visible* items (counts show what selecting
 * the chip would leave), count-desc then title-asc. `omit` drops the
 * current page's own title and titles already active as filters. */
export function chipCounts(visible: BacklinkGroup[], omit: Iterable<string>): Chip[] {
  const skip = new Set(omit);
  const counts = new Map<string, number>();
  for (const g of visible)
    for (const it of g.items)
      for (const t of itemRefTitles(it))
        if (!skip.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

/** Add `title` to `side`, moving it off the other side if present; if it
 * is already on `side`, clear it entirely (click-again-to-remove). */
export function toggleChip(f: FilterState, title: string,
                           side: "include" | "exclude"): FilterState {
  const include = f.include.filter((t) => t !== title);
  const exclude = f.exclude.filter((t) => t !== title);
  if (f[side].includes(title)) return { include, exclude };
  if (side === "include") return { include: [...include, title], exclude };
  return { include, exclude: [...exclude, title] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm vitest run src/components/backlinkFilter.test.ts`
Expected: PASS (all tests).

Note: `applyFilter` returns the *same array reference* for the empty filter — the first test asserts `toBe`. If the `#[[Constitutional AI]]` case fails, check `extractRefs` output ordering assumptions, not the scanner.

- [ ] **Step 5: Commit**

```bash
git status -sb   # confirm branch + only intended files
git add src/components/backlinkFilter.ts src/components/backlinkFilter.test.ts
git commit -m "Add backlink filter functional core (pkm-m4an)"
```

---

### Task 2: Filter UI in `BacklinksSection` + CSS

**Files:**
- Modify: `web/src/components/BacklinksSection.tsx` (whole file shown below)
- Modify: `web/src/styles.css` (append after the `.backlinks`/`.query-item` rules, around line 445)
- Test: `web/src/components/sections.test.tsx` (append tests)

**Interfaces:**
- Consumes: everything Task 1 produces; existing `mergeGroups` from `./groups`; `apiFetch`, `encodeTitle`, `BlockRefContext`, `tokenizeBlock`, `InlineSegments`, `PageLink` (already imported by the file).
- Produces: DOM/classes the E2E spec (Task 3) relies on — `.filter-toggle` (header button, text `Filter`), `.filter-panel`, `.filter-candidates .filter-chip` (text `Title (count)`), `.filter-active .filter-chip.included/.excluded`, `.filter-clear` (text `Clear`), `.filter-no-match`, header text `Linked references (N of M)` while filtering.

- [ ] **Step 1: Write the failing component tests**

Append to `web/src/components/sections.test.tsx`:

```tsx
const filterInitial: Backlinks = {
  groups: [
    { page_id: 1, page_title: "Daily A", items: [
      { uid: "f1", text: "alpha [[Claude]] #Paper", breadcrumbs: [] },
      { uid: "f2", text: "beta [[Claude]] #Idea", breadcrumbs: [] }] },
    { page_id: 2, page_title: "Daily B", items: [
      { uid: "f3", text: "gamma [[Claude]]", breadcrumbs: ["reading #Paper"] }] },
  ],
  total_pages: 2, offset: 0, limit: 20,
};

it("filter panel: include, exclude via shift-click, clear (pkm-m4an)", () => {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Claude" initial={filterInitial} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /filter/i }));
  // chips over all items; own title "Claude" absent; breadcrumb #Paper counted
  expect(screen.getByRole("button", { name: "Paper (2)" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Idea (1)" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Claude/ })).toBeNull();

  // include Idea -> only beta remains, Daily B group gone, header N of M
  fireEvent.click(screen.getByRole("button", { name: "Idea (1)" }));
  expect(screen.getByText(/linked references \(1 of 2\)/i)).toBeInTheDocument();
  expect(screen.getByText(/beta/)).toBeInTheDocument();
  expect(screen.queryByText(/alpha/)).toBeNull();
  expect(screen.queryByRole("link", { name: "Daily B" })).toBeNull();

  // clear -> everything back
  fireEvent.click(screen.getByRole("button", { name: /clear/i }));
  expect(screen.getByText(/linked references \(2\)/i)).toBeInTheDocument();
  expect(screen.getByText(/alpha/)).toBeInTheDocument();

  // exclude Paper (shift-click) -> f1 (own text) and f3 (ancestor) hidden
  fireEvent.click(screen.getByRole("button", { name: "Paper (2)" }), { shiftKey: true });
  expect(screen.getByText(/beta/)).toBeInTheDocument();
  expect(screen.queryByText(/alpha/)).toBeNull();
  expect(screen.queryByText(/gamma/)).toBeNull();

  // exclude Idea too -> nothing matches
  fireEvent.click(screen.getByRole("button", { name: "Idea (1)" }), { shiftKey: true });
  expect(screen.getByText(/no matching references/i)).toBeInTheDocument();
});

it("opening the filter panel loads all remaining backlinks first (pkm-m4an)", async () => {
  const rest = pagePayload("Claude", [], {
    backlinks: {
      groups: [{ page_id: 5, page_title: "Daily C", items: [
        { uid: "f9", text: "delta [[Claude]] #Paper", breadcrumbs: [] }] }],
      total_pages: 2, offset: 1, limit: 100,
    },
  });
  const fetchMock = stubFetch([["/api/page/Claude?bl_offset=1&bl_limit=100", rest]]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="Claude"
        initial={{ ...filterInitial, groups: filterInitial.groups.slice(0, 1) }} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: /filter/i }));
  // chips appear only once the remaining page is fetched (bl_limit=100)
  expect(await screen.findByRole("button", { name: "Paper (2)" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/page/Claude?bl_offset=1&bl_limit=100", undefined);
  // show-more is hidden while the panel is open, even though it was eligible
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm vitest run src/components/sections.test.tsx`
Expected: FAIL — no button matching `/filter/i` (existing tests still pass).

- [ ] **Step 3: Rewrite `BacklinksSection.tsx`**

Replace the whole file with:

```tsx
// pattern: Imperative Shell
import { useContext, useMemo, useState } from "react";
import { apiFetch } from "../api/client";
import type { BacklinkGroup, Backlinks, BlockRefText, PagePayload } from "../api/payloads";
import { BlockRefContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { encodeTitle } from "../paths";
import { applyFilter, chipCounts, EMPTY_FILTER, isFiltering, toggleChip,
         type FilterState } from "./backlinkFilter";
import { mergeGroups } from "./groups";
import { InlineSegments } from "./InlineSegments";
import { PageLink } from "./PageLink";

export function BacklinksSection({ title, initial }:
    { title: string; initial: Backlinks }) {
  const base = useContext(BlockRefContext);
  const [groups, setGroups] = useState<BacklinkGroup[]>(initial.groups);
  const [extraRefTexts, setExtraRefTexts] =
    useState<Record<string, BlockRefText>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const hasMore = groups.length < initial.total_pages;
  const fullyLoaded = !hasMore;

  const fetchBatch = async (offset: number, limit: number) => {
    // bl pagination counts source pages; the accumulated length is the
    // next offset.
    const p = await apiFetch<PagePayload>(
      `/api/page/${encodeTitle(title)}?bl_offset=${offset}&bl_limit=${limit}`);
    setExtraRefTexts((m) => ({ ...m, ...p.block_ref_texts }));
    return p.backlinks;
  };

  const loadMore = async () => {
    setLoading(true);
    setError(null);
    try {
      const batch = await fetchBatch(groups.length, initial.limit);
      setGroups((g) => mergeGroups(g, batch.groups));
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // The filter panel needs every backlink loaded: chips and counts must
  // not lie about pages that simply weren't fetched yet.
  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      let all = groups;
      let total = initial.total_pages;
      while (all.length < total) {
        const batch = await fetchBatch(all.length, 100);
        if (batch.groups.length === 0) break; // total shrank server-side
        total = batch.total_pages; // ...or grew: trust the latest response
        all = mergeGroups(all, batch.groups);
        setGroups(all);
      }
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const openPanel = () => {
    setPanelOpen(true);
    if (hasMore) void loadAll();
  };

  const filtering = isFiltering(filter);
  const visible = useMemo(() => applyFilter(groups, filter), [groups, filter]);
  const chips = useMemo(
    () => panelOpen && fullyLoaded
      ? chipCounts(visible, [title, ...filter.include, ...filter.exclude])
      : [],
    [panelOpen, fullyLoaded, visible, title, filter]);

  const chipButton = (t: string, side: "include" | "exclude", label: string) => (
    <button key={`${side}:${t}`} className={`filter-chip ${side}d`}
            onClick={() => setFilter((f) => toggleChip(f, t, side))}>
      {label}
    </button>
  );

  return (
    <BlockRefContext.Provider value={{ ...base, ...extraRefTexts }}>
      <section className="backlinks">
        <h2 className="section-header">
          Linked references ({filtering
            ? `${visible.length} of ${initial.total_pages}` : initial.total_pages})
          {initial.total_pages > 0 && (
            <button className="filter-toggle btn-secondary" aria-expanded={panelOpen}
                    onClick={() => (panelOpen ? setPanelOpen(false) : openPanel())}>
              Filter{filtering
                ? ` (${filter.include.length + filter.exclude.length})` : ""}
            </button>
          )}
        </h2>
        {panelOpen && (
          <div className="filter-panel">
            {filtering && (
              <div className="filter-active">
                {filter.include.map((t) => chipButton(t, "include", t))}
                {filter.exclude.map((t) => chipButton(t, "exclude", t))}
                <button className="filter-clear"
                        onClick={() => setFilter(EMPTY_FILTER)}>Clear</button>
              </div>
            )}
            {!fullyLoaded && !error &&
              <p className="filter-loading">Loading all references…</p>}
            {fullyLoaded && (
              <div className="filter-candidates">
                {chips.map((c) => (
                  <button key={c.title} className="filter-chip"
                          title="Click to include, shift-click to exclude"
                          onClick={(e) => setFilter((f) =>
                            toggleChip(f, c.title, e.shiftKey ? "exclude" : "include"))}>
                    {c.title} ({c.count})
                  </button>
                ))}
                {chips.length === 0 && !filtering &&
                  <p className="filter-empty">No references to filter on</p>}
              </div>
            )}
          </div>
        )}
        {visible.map((g) => (
          <div className="backlink-group" key={g.page_id}>
            <h3 className="group-title"><PageLink title={g.page_title} tag={false} /></h3>
            {g.items.map((item) => (
              <div className="backlink-item" key={item.uid}>
                {item.breadcrumbs.length > 0 && (
                  <div className="breadcrumbs">{item.breadcrumbs.join(" › ")}</div>
                )}
                <div className="backlink-text">
                  <InlineSegments segments={tokenizeBlock(item.text)} />
                </div>
              </div>
            ))}
          </div>
        ))}
        {filtering && fullyLoaded && visible.length === 0 && (
          <p className="filter-no-match">No matching references</p>
        )}
        {error && <p className="error">{error}</p>}
        {error && panelOpen && !fullyLoaded && (
          <button className="show-more btn-secondary" onClick={() => void loadAll()}
                  disabled={loading}>
            {loading ? "Loading…" : "Retry"}
          </button>
        )}
        {hasMore && !panelOpen && (
          <button className="show-more btn-secondary" onClick={() => void loadMore()}
                  disabled={loading}>
            {loading ? "Loading…" : "Show more"}
          </button>
        )}
      </section>
    </BlockRefContext.Provider>
  );
}
```

Notes for the implementer:
- `chipButton` renders class `included`/`excluded` (side + `d`).
- Closing the panel keeps active filters (the header count and `Filter (n)` badge still show them); only navigation resets state.
- `loadAll` intentionally reassigns a local `all` and calls `setGroups(all)` per batch — don't convert to functional updates inside the loop; the loop needs the accumulated value synchronously.

- [ ] **Step 4: Run component tests**

Run: `cd web && pnpm vitest run src/components/sections.test.tsx src/components/backlinkFilter.test.ts`
Expected: PASS, including the pre-existing backlinks tests (header regex `/linked references \(2\)/i` still matches the unfiltered render).

- [ ] **Step 5: Add CSS**

Append to `web/src/styles.css`, directly after the `.backlink-item:hover, .query-item:hover` rule (~line 445):

```css
/* linked-refs filter (pkm-m4an) */
.section-header .filter-toggle { margin-left: 10px; font-size: 12px;
  text-transform: none; letter-spacing: normal; padding: 1px 10px; }
.filter-panel { margin: 8px 0 12px; padding: 8px 10px;
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-card); }
.filter-active { display: flex; flex-wrap: wrap; align-items: center;
  gap: 6px; margin-bottom: 8px; }
.filter-candidates { display: flex; flex-wrap: wrap; gap: 6px; }
.filter-chip { font-size: 13px; padding: 1px 10px; border-radius: 999px;
  background: var(--color-bg); border: 1px solid var(--color-border-subtle);
  color: var(--color-text-secondary); cursor: pointer; }
.filter-chip:hover { border-color: var(--color-border-input);
  color: var(--color-text); }
.filter-chip.included { background: var(--color-selected-bg);
  border-color: var(--color-border-input); color: var(--color-text); }
.filter-chip.excluded { text-decoration: line-through; opacity: 0.7; }
.filter-clear { font-size: 12px; background: none; border: none;
  color: var(--color-link-ext); cursor: pointer; }
.filter-loading, .filter-empty, .filter-no-match { font-size: 13px;
  color: var(--color-text-secondary); }
```

(All custom properties already exist in `:root`; `--radius-card` is the 6px card radius from pkm-9kye.)

- [ ] **Step 6: Typecheck, lint, FCIS check**

Run: `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git status -sb   # confirm branch + only intended files
git add src/components/BacklinksSection.tsx src/components/sections.test.tsx src/styles.css
git commit -m "Add Roam-style filter panel to Linked References (pkm-m4an)"
```

---

### Task 3: Playwright E2E

**Files:**
- Create: `web/e2e/backlink-filter.spec.ts`

**Interfaces:**
- Consumes: Task 2's DOM (`.filter-toggle`, `.filter-candidates .filter-chip`, `.filter-clear`, `.backlink-item`, `.filter-no-match`); shared e2e `fixtures.ts` (`test`, `expect` — 5xx-tracking wrappers); app editor behaviour (textarea `textarea.block-input`, Enter = new block, Tab = indent, Escape = leave edit mode); login page at `/login`, password `e2e-pw`; page route `/page/<title>`.
- Produces: nothing downstream.

- [ ] **Step 1: Write the spec**

Create `web/e2e/backlink-filter.spec.ts`:

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

const input = (page: Page) => page.locator("textarea.block-input");

const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

test("linked-refs filter: include, exclude, ancestor tags (pkm-m4an)", async ({ page }) => {
  // unique target page per run: the e2e DB is shared across specs/retries
  const tgt = `FilterTgt${Date.now()}`;
  await login(page);
  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();

  // append after whatever is already on today's page (shared E2E DB)
  const startWriting = today.getByText("Click to start writing…");
  if (await startWriting.count() > 0) {
    await startWriting.click();
  } else {
    await today.locator(".block-text").first().click();
    await caretToEnd(page);
    await input(page).press("Enter");
  }

  await input(page).fill(`alpha [[${tgt}]] #FTagA`);
  await input(page).press("Enter");
  await input(page).fill(`beta [[${tgt}]] #FTagB`);
  await input(page).press("Enter");
  await input(page).fill("parent block #FTagC");
  await input(page).press("Enter");
  await input(page).press("Tab"); // nest under "parent block #FTagC"
  await input(page).fill(`gamma [[${tgt}]]`);
  await input(page).press("Escape");

  await page.goto(`/page/${tgt}`);
  const header = page.locator(".backlinks .section-header");
  await expect(header).toContainText("Linked references (1)"); // 1 source page

  await page.click(".filter-toggle");
  const chip = (label: string) =>
    page.locator(".filter-candidates .filter-chip", { hasText: label });

  // include FTagA -> only alpha; header shows N of M
  await chip("FTagA").click();
  await expect(page.locator(".backlink-item")).toHaveCount(1);
  await expect(page.locator(".backlink-item")).toContainText("alpha");
  await expect(header).toContainText("(1 of 1)");

  // clear, exclude FTagA -> beta and gamma remain
  await page.click(".filter-clear");
  await chip("FTagA").click({ modifiers: ["Shift"] });
  await expect(page.locator(".backlink-item")).toHaveCount(2);
  await expect(page.locator(".backlink-item").filter({ hasText: "alpha" })).toHaveCount(0);

  // ancestor inheritance: include FTagC (parent's tag) -> gamma only
  await page.click(".filter-clear");
  await chip("FTagC").click();
  await expect(page.locator(".backlink-item")).toHaveCount(1);
  await expect(page.locator(".backlink-item")).toContainText("gamma");

  // exclude everything -> empty state message
  await page.click(".filter-clear");
  await chip("FTagA").click({ modifiers: ["Shift"] });
  await chip("FTagB").click({ modifiers: ["Shift"] });
  await chip("FTagC").click({ modifiers: ["Shift"] });
  await expect(page.locator(".filter-no-match")).toBeVisible();
  await expect(page.locator(".backlink-item")).toHaveCount(0);
});
```

- [ ] **Step 2: Run the spec**

Run: `cd web && pnpm build && node tooling/runPlaywright.mjs e2e/backlink-filter.spec.ts`
Expected: PASS. (`pnpm e2e` runs the whole suite; the build step is required — Playwright serves `web/dist`. If port 8975 clashes, set `E2E_PORT`.)

Troubleshooting expectations:
- If the include-FTagA step finds 0 items, check the chips actually rendered (`.filter-candidates`) — a missing `#FTagC` chip means the Tab-indent didn't nest gamma and its breadcrumb is empty.
- If `Linked references (1)` fails with `(0)`, the journal blocks didn't commit — Escape must blur the editor before navigating away.

- [ ] **Step 3: Commit**

```bash
git status -sb
git add e2e/backlink-filter.spec.ts
git commit -m "E2E: linked-refs filter include/exclude/ancestor (pkm-m4an)"
```

---

### Task 4: Full verification + bean completion

**Files:**
- Modify: `.beans/pkm-m4an--linked-reference-view-filters.md`

- [ ] **Step 1: Run the full web verification suite**

Run: `cd web && pnpm verify`
Expected: typecheck, lint, FCIS check, unit tests with coverage thresholds, build, and the whole Playwright suite all pass, warning-free.

- [ ] **Step 2: Server suite untouched — sanity check**

Run: `git status -sb` — confirm no files under `server/` changed. (No server tests needed; this feature is client-only.)

- [ ] **Step 3: Complete the bean**

Set `status: completed` in the bean frontmatter (`beans update pkm-m4an -s completed`) and append a `## Summary of Changes` section describing: functional-core `backlinkFilter.ts`, panel UI in `BacklinksSection`, load-all pagination, CSS chips, unit + component + E2E tests.

- [ ] **Step 4: Commit**

```bash
git status -sb
git add .beans/pkm-m4an--linked-reference-view-filters.md
git commit -m "chore(beans): mark pkm-m4an completed"
```

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch — merge to `main` with `git merge --no-ff`, run the test suites once more on `main`, push (always push after committing).
