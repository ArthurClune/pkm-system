# Date Shortcuts (`/today`, `/tomorrow`, `/date`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three new slash-menu commands in the outline editor: `/today` inserts `[[July 29th, 2026]]` (today's daily-note link), `/tomorrow` inserts tomorrow's, and `/date` opens an inline month-grid date picker whose day-click inserts that date's daily-note link. Bean: pkm-rw6w.

**Architecture:** `/today` and `/tomorrow` are pure text transforms in `web/src/outline/slashCommands.ts` (`applySlashCommand` gains a required `now: Date` parameter — the clock read stays in the shell, per FCIS). `/date` follows the `/upload` shape in `pick()` (strip trigger, record offset) but opens a **focus-preserving inline picker** rendered inside `BlockInput` next to `AutocompletePopup`: every interactive element handles `onMouseDown` + `preventDefault` (the same trick as `AutocompletePopup` rows), so the textarea never blurs, `BlockInput` never unmounts, and insertion rides the normal `setText` draft path — no new `OutlineHandlers` member, no prop drilling, no tree-owned overlay.

**Tech Stack:** React + TypeScript (web/ only, no server changes), vitest + Testing Library unit tests, Playwright e2e. No new dependencies — the picker is built from scratch on a pure calendar-grid helper.

## Global Constraints

- Slash-command labels are **lowercase only** (user preference, e.g. `"link to today"`, never `"Link to today"`).
- New `SLASH_COMMANDS` entries are **appended after** all existing entries — existing tests depend on row order for `/t` queries (`EditableBlockTree.test.tsx:357` and `:369`).
- `docs/keyboard.md` must contain the literal backticked token (e.g. `` `/today` ``) for every `SLASH_COMMANDS` entry — the drift-guard test `web/src/help/slashCommandsDocumented.test.ts` fails otherwise. Update the doc **in the same commit** as the `SLASH_COMMANDS` change.
- FCIS: every new runtime file declares `// pattern: Functional Core` or `// pattern: Imperative Shell` on line 1. Clock reads (`new Date()` with no args, `Date.now()`) are I/O — **forbidden in Functional Core files**; they happen in `EditableBlockTree.tsx` (shell) and are passed in as parameters. `pnpm check:fcis` enforces headers and import direction (Core must not import Shell).
- Daily-note titles come **only** from `titleForDate` in `web/src/replica/daily.ts` — never re-implement the ordinal format.
- Enforced web coverage thresholds (vite.config.ts): statements 95, branches 91, functions 89, lines 95 — new code needs tests.
- Run all commands from the worktree root `/Users/arthur/code/llm/pkm/.claude/worktrees/pkm-rw6w-date-shortcuts` (never the main checkout). Check `git status -sb` before every commit.
- Calendar weeks start on **Monday** (UK user).

---

### Task 1: `/today` and `/tomorrow` core transforms

**Files:**
- Modify: `web/src/outline/slashCommands.ts`
- Modify: `web/src/components/EditableBlockTree.tsx:552-554` (one call site gains an argument)
- Modify: `docs/keyboard.md` (table at lines 98–110)
- Test: `web/src/outline/slashCommands.test.ts`

**Interfaces:**
- Consumes: `titleForDate(d: Date): string` from `web/src/replica/daily.ts` (Core→Core import, allowed).
- Produces: `applySlashCommand(text: string, cursor: number, ctx: AcContext, command: string, now: Date): { text: string; cursor: number }` — the 5th parameter is **required**. Task 3 relies on this signature and on the `SLASH_COMMANDS` append position.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/outline/slashCommands.test.ts` (mirror the file's existing describe/test idiom; note every existing `applySlashCommand` call in this file must gain a 5th argument — define one shared `const NOW = new Date(2026, 6, 29)` near the top and pass it mechanically):

```ts
describe("today / tomorrow (pkm-rw6w)", () => {
  test("today is offered and inserts a link to today's daily note", () => {
    expect(matchSlashCommands("toda"))
      .toEqual([{ name: "today", label: "link to today" }]);
    expect(applySlashCommand("/today", 6,
      { kind: "command", start: 1, query: "today" }, "today",
      new Date(2026, 6, 29)))
      .toEqual({ text: "[[July 29th, 2026]]", cursor: 19 });
  });

  test("tomorrow rolls over month and year ends", () => {
    expect(matchSlashCommands("tom"))
      .toEqual([{ name: "tomorrow", label: "link to tomorrow" }]);
    expect(applySlashCommand("/tom", 4,
      { kind: "command", start: 1, query: "tom" }, "tomorrow",
      new Date(2026, 6, 31)))
      .toEqual({ text: "[[August 1st, 2026]]", cursor: 20 });
    expect(applySlashCommand("/tom", 4,
      { kind: "command", start: 1, query: "tom" }, "tomorrow",
      new Date(2026, 11, 31)))
      .toEqual({ text: "[[January 1st, 2027]]", cursor: 21 });
  });

  test("insertion preserves surrounding text, cursor lands after the link", () => {
    expect(applySlashCommand("see /tod later", 8,
      { kind: "command", start: 5, query: "tod" }, "today",
      new Date(2026, 6, 29)))
      .toEqual({ text: "see [[July 29th, 2026]] later", cursor: 23 });
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd web && pnpm test:unit -- src/outline/slashCommands.test.ts`
Expected: new tests FAIL (`today` not in `SLASH_COMMANDS`; `applySlashCommand` ignores 5th arg). Pre-existing tests may also fail on arity/type until Step 3 — that's fine.

- [ ] **Step 3: Implement**

In `web/src/outline/slashCommands.ts`:

Append to `SLASH_COMMANDS` (after `query-and-not`, the last entry):

```ts
  // Daily-note link shortcuts (pkm-rw6w). applySlashCommand takes the
  // current date from the shell (clock reads are I/O, so the core never
  // calls new Date() itself).
  { name: "today", label: "link to today" },
  { name: "tomorrow", label: "link to tomorrow" },
```

Add the import and helper:

```ts
import { titleForDate } from "../replica/daily";

/** Insert a [[daily-note]] link for `d` at `at`, cursor after the link. */
function dailyLink(content: string, at: number, d: Date): { text: string; cursor: number } {
  const link = `[[${titleForDate(d)}]]`;
  const text = content.slice(0, at) + link + content.slice(at);
  return { text, cursor: at + link.length };
}
```

Extend `applySlashCommand`'s signature and switch:

```ts
export function applySlashCommand(
  text: string, cursor: number, ctx: AcContext, command: string, now: Date,
): { text: string; cursor: number } {
  const content = text.slice(0, ctx.start - 1) + text.slice(cursor);
  switch (command) {
    // ... existing cases unchanged ...
    case "today": return dailyLink(content, ctx.start - 1, now);
    case "tomorrow":
      return dailyLink(content, ctx.start - 1,
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    default: return { text: content, cursor: content.length };
  }
}
```

(`new Date(y, m, d + 1)` is date **arithmetic** on a passed-in value, not a clock read — fine in the core; the Date constructor normalizes month/year rollover.)

In `web/src/components/EditableBlockTree.tsx` (~line 553), update the one call site:

```ts
    const applied = row.command
      ? applySlashCommand(draft, caret, ac, row.command, new Date())
      : applyCompletion(draft, caret, ac, row.title);
```

In `docs/keyboard.md`, add one row to the slash-command table (after the `/query-and-not` row):

```markdown
| `/today`, `/tomorrow` | Insert a link to today's / tomorrow's daily note |
```

- [ ] **Step 4: Fix existing tests broken by the new entries/signature**

Run: `cd web && pnpm test:unit`
Expected breakage to fix (these updates are expected, not regressions):
- Any `applySlashCommand(...)` call in `slashCommands.test.ts` missing the 5th arg → pass `NOW`.
- Any **exact-list** assertion on `matchSlashCommands("t"...)`-style queries (in `slashCommands.test.ts` or `EditableBlockTree.test.tsx`) → append the new trailing entries. Behavioral tests that ArrowDown once to reach `to-do` are unaffected (entries are appended, so rows 1–2 for `/t` are unchanged).
Do NOT reorder rows or change existing behavior to make a test pass — if a fix would require that, report BLOCKED.

- [ ] **Step 5: Run full unit suite + typecheck to verify green**

Run: `cd web && pnpm test:unit && pnpm typecheck`
Expected: PASS (baseline was 1590 tests; now more).

- [ ] **Step 6: Commit**

```bash
git add web/src/outline/slashCommands.ts web/src/outline/slashCommands.test.ts web/src/components/EditableBlockTree.tsx docs/keyboard.md
git commit -m "feat(web): /today and /tomorrow slash commands insert daily-note links (pkm-rw6w)"
```

---

### Task 2: Calendar-grid core + `DatePickerPopup` component

**Files:**
- Create: `web/src/outline/calendar.ts`
- Create: `web/src/outline/calendar.test.ts`
- Create: `web/src/components/DatePickerPopup.tsx`
- Create: `web/src/components/DatePickerPopup.test.tsx`
- Modify: `web/src/replica/daily.ts:6-8` (export `MONTHS`)
- Modify: `web/src/styles.css` (new rules after `.ac-row.selected`, ~line 642)

**Interfaces:**
- Consumes: `MONTHS` from `web/src/replica/daily.ts` (add `export` to the existing `const MONTHS` declaration — no other change to that file).
- Produces: `calendarWeeks(year: number, month: number): CalendarCell[][]` and `monthLabel(year: number, month: number): string` (month is 0-based like `Date`); `<DatePickerPopup initial={Date} onPick={(d: Date) => void} />`. Task 3 renders `DatePickerPopup` and receives local-midnight `Date`s from `onPick`.

- [ ] **Step 1: Write the failing core tests**

Create `web/src/outline/calendar.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { calendarWeeks, monthLabel } from "./calendar";

describe("calendarWeeks (pkm-rw6w)", () => {
  test("July 2026: Monday-first grid, June 29 through August 2, 5 weeks", () => {
    const weeks = calendarWeeks(2026, 6);
    expect(weeks).toHaveLength(5);
    const first = weeks[0][0];
    const last = weeks[4][6];
    expect(first.date).toEqual(new Date(2026, 5, 29));
    expect(first.day).toBe(29);
    expect(first.inMonth).toBe(false);
    expect(last.date).toEqual(new Date(2026, 7, 2));
    expect(last.inMonth).toBe(false);
    expect(weeks[0][2]).toEqual({ date: new Date(2026, 6, 1), day: 1, inMonth: true });
  });

  test("every week has 7 cells and all month days appear in order", () => {
    const weeks = calendarWeeks(2026, 6);
    for (const w of weeks) expect(w).toHaveLength(7);
    const inMonth = weeks.flat().filter((c) => c.inMonth).map((c) => c.day);
    expect(inMonth).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  });

  test("February 2027 is an exact 4-week grid with no outside days", () => {
    const weeks = calendarWeeks(2027, 1);
    expect(weeks).toHaveLength(4);
    expect(weeks.flat().every((c) => c.inMonth)).toBe(true);
  });

  test("monthLabel", () => {
    expect(monthLabel(2026, 6)).toBe("July 2026");
    expect(monthLabel(2027, 0)).toBe("January 2027");
  });
});
```

(If the repo's test files don't import from "vitest" explicitly, match whatever `web/src/outline/slashCommands.test.ts` does.)

- [ ] **Step 2: Run to verify failure**

Run: `cd web && pnpm test:unit -- src/outline/calendar.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the core**

Add `export` to `MONTHS` in `web/src/replica/daily.ts` (keyword only, no other edit).

Create `web/src/outline/calendar.ts`:

```ts
// pattern: Functional Core
// Month-grid maths for the /date picker (pkm-rw6w): a Monday-first grid of
// whole weeks covering the given month, with leading/trailing days from the
// adjacent months marked inMonth: false. All dates are local midnights,
// matching replica/daily.ts's convention.
import { MONTHS } from "../replica/daily";

export interface CalendarCell {
  date: Date;
  day: number;
  inMonth: boolean;
}

/** Mo..Su — calendar weeks start on Monday. */
export const WEEKDAY_HEADERS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month]} ${year}`;
}

export function calendarWeeks(year: number, month: number): CalendarCell[][] {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7; // days before the 1st, Monday-first
  const d = new Date(year, month, 1 - lead);
  const weeks: CalendarCell[][] = [];
  do {
    const week: CalendarCell[] = [];
    for (let i = 0; i < 7; i++) {
      week.push({ date: new Date(d), day: d.getDate(), inMonth: d.getMonth() === month });
      d.setDate(d.getDate() + 1);
    }
    weeks.push(week);
  } while (d.getMonth() === month);
  return weeks;
}
```

- [ ] **Step 4: Run core tests to verify pass**

Run: `cd web && pnpm test:unit -- src/outline/calendar.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component test**

Create `web/src/components/DatePickerPopup.test.tsx` (mirror the render/fireEvent idiom of `web/src/components/EditableBlockTree.test.tsx` — same imports, same assertion style; use `fireEvent.mouseDown`, NOT `click`, since the component is mouse-down-driven):

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { DatePickerPopup } from "./DatePickerPopup";

describe("DatePickerPopup (pkm-rw6w)", () => {
  test("shows the initial month and reports a clicked day", () => {
    const onPick = vi.fn();
    render(<DatePickerPopup initial={new Date(2026, 6, 29)} onPick={onPick} />);
    expect(screen.getByText("July 2026")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("button", { name: "15" }));
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 6, 15));
  });

  test("month navigation moves the view without firing onPick", () => {
    const onPick = vi.fn();
    render(<DatePickerPopup initial={new Date(2026, 6, 29)} onPick={onPick} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "previous month" }));
    expect(screen.getByText("June 2026")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("button", { name: "next month" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "next month" }));
    expect(screen.getByText("August 2026")).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
    // mid-month day: edge numbers (29-31, 1-2) can appear twice in a grid
    // (outside cells), so only days 3-28 are safe for name-based queries
    fireEvent.mouseDown(screen.getByRole("button", { name: "20" }));
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 7, 20));
  });

  test("days outside the month are marked and still pickable", () => {
    const onPick = vi.fn();
    const { container } = render(
      <DatePickerPopup initial={new Date(2026, 6, 29)} onPick={onPick} />);
    const outside = container.querySelectorAll(".date-picker-day.outside");
    expect(outside.length).toBe(4); // Jun 29, 30 + Aug 1, 2
    fireEvent.mouseDown(outside[0]);
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 5, 29));
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `cd web && pnpm test:unit -- src/components/DatePickerPopup.test.tsx`
Expected: FAIL — component doesn't exist.

- [ ] **Step 7: Implement the component**

Create `web/src/components/DatePickerPopup.tsx`:

```tsx
// pattern: Imperative Shell
// Inline month-grid picker for the /date slash command (pkm-rw6w).
// Mouse-only BY DESIGN: every interactive element handles onMouseDown +
// preventDefault (the AutocompletePopup row trick) so the block textarea
// never loses focus — BlockInput stays mounted and the insertion can ride
// the normal setText draft path, unlike /upload's focus-stealing native
// dialog. Keyboard access is Escape-to-close, handled by BlockInput.
import { useState } from "react";
import { calendarWeeks, monthLabel, WEEKDAY_HEADERS } from "../outline/calendar";

export function DatePickerPopup({ initial, onPick }: {
  initial: Date; onPick: (d: Date) => void;
}) {
  const [view, setView] = useState(
    { year: initial.getFullYear(), month: initial.getMonth() });
  const move = (delta: number) => {
    const d = new Date(view.year, view.month + delta, 1);
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };
  const todayMs = new Date(initial.getFullYear(), initial.getMonth(),
                           initial.getDate()).getTime();
  return (
    <div className="date-picker" role="dialog" aria-label="pick a date">
      <div className="date-picker-header">
        <button type="button" aria-label="previous month"
                onMouseDown={(e) => { e.preventDefault(); move(-1); }}>‹</button>
        <span>{monthLabel(view.year, view.month)}</span>
        <button type="button" aria-label="next month"
                onMouseDown={(e) => { e.preventDefault(); move(1); }}>›</button>
      </div>
      <div className="date-picker-grid">
        {WEEKDAY_HEADERS.map((h) => (
          <span key={h} className="date-picker-dow">{h}</span>
        ))}
        {calendarWeeks(view.year, view.month).flat().map((cell) => (
          <button key={cell.date.getTime()} type="button"
                  className={"date-picker-day"
                    + (cell.inMonth ? "" : " outside")
                    + (cell.date.getTime() === todayMs ? " today" : "")}
                  onMouseDown={(e) => { e.preventDefault(); onPick(cell.date); }}>
            {cell.day}
          </button>
        ))}
      </div>
    </div>
  );
}
```

Add to `web/src/styles.css`, directly after the `.ac-row.selected` rule (~line 642). Before writing, check `:root` for the repo's muted-text token (grep `muted` in styles.css) and use it for `--color-text-muted` below if it's named differently:

```css
/* --- /date picker (pkm-rw6w) --- */
.date-picker { position: absolute; top: 100%; left: 0; z-index: 50;
  background: var(--color-bg-surface); border: 1px solid var(--color-border-input); border-radius: var(--radius-panel);
  box-shadow: 0 4px 14px rgba(var(--shadow-rgb), 0.15); padding: 8px; width: 252px; }
.date-picker-header { display: flex; align-items: center;
  justify-content: space-between; padding: 0 2px 6px; font-weight: 600; }
.date-picker-header button { background: none; border: none; cursor: pointer;
  font: inherit; color: var(--color-text); padding: 2px 8px; }
.date-picker-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.date-picker-dow { text-align: center; font-size: 0.75rem; padding: 2px 0; }
.date-picker-day { background: none; border: none; cursor: pointer; font: inherit;
  color: var(--color-text); padding: 4px 0; text-align: center; border-radius: 4px; }
.date-picker-day:hover { background: var(--color-ac-selected-bg); }
.date-picker-day.outside { opacity: 0.45; }
.date-picker-day.today { font-weight: 600; }
```

- [ ] **Step 8: Run tests + FCIS check to verify pass**

Run: `cd web && pnpm test:unit -- src/outline/calendar.test.ts src/components/DatePickerPopup.test.tsx && pnpm check:fcis && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src/outline/calendar.ts web/src/outline/calendar.test.ts web/src/components/DatePickerPopup.tsx web/src/components/DatePickerPopup.test.tsx web/src/replica/daily.ts web/src/styles.css
git commit -m "feat(web): calendar-grid core and DatePickerPopup component (pkm-rw6w)"
```

---

### Task 3: Wire `/date` into the editor

**Files:**
- Modify: `web/src/outline/slashCommands.ts` (one appended entry)
- Modify: `web/src/components/EditableBlockTree.tsx` (BlockInput: state, pick() case, onChange/applyKeyEdit/onKeyDown hooks, render)
- Modify: `docs/keyboard.md` (one table row)
- Test: `web/src/components/EditableBlockTree.test.tsx`

**Interfaces:**
- Consumes: `<DatePickerPopup initial onPick />` from Task 2; `titleForDate` from `web/src/replica/daily.ts`; `applySlashCommand(text, cursor, ctx, command, now)` from Task 1.
- Produces: user-facing `/date` behavior. Nothing downstream.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/components/EditableBlockTree.test.tsx`, following the file's existing idioms exactly — use its `handlers()` factory (line 10), `mount()` helper (line 34), and copy the typing/fireEvent style of the existing slash tests at lines 344–455 (e.g. how they get the textarea, `fireEvent.change` to type `/date`, ArrowDown/Enter or `mouseDown` on the popup row to pick). Import `titleForDate` from `../replica/daily` for expected strings:

```tsx
describe("/date picker (pkm-rw6w)", () => {
  test("picking /date strips the trigger and opens the picker", () => {
    // type "/date" into the focused block, pick the "link to a date…" row
    // (Enter or mouseDown, matching the existing slash-test idiom)
    // then assert:
    //   - handlers.onDraftChange last called with ("u1", "")  [trigger stripped]
    //   - screen.getByRole("dialog", { name: "pick a date" }) exists
  });

  test("clicking a day inserts that date's daily-note link and closes the picker", () => {
    // open the picker as above, then:
    // fireEvent.mouseDown(screen.getByRole("button", { name: "15" }));
    // const now = new Date();
    // const expected = `[[${titleForDate(new Date(now.getFullYear(), now.getMonth(), 15))}]]`;
    // assert handlers.onDraftChange last called with ("u1", expected)
    // assert the dialog is gone (queryByRole returns null)
  });

  test("Escape closes the picker without inserting", () => {
    // open the picker, fireEvent.keyDown(textarea, { key: "Escape" });
    // assert dialog gone and onDraftChange was NOT called again after the strip
  });

  test("typing while the picker is open closes it", () => {
    // open the picker, fireEvent.change(textarea, { target: { value: "x" } });
    // assert dialog gone
  });

  test("readOnly tree never renders a picker", () => {
    // mount readOnly (see the existing "readOnly tree renders no upload input"
    // test near line 800 for the idiom) and assert no dialog can be opened
  });
});
```

Write real test bodies from the comments above — the comments describe the required assertions, the surrounding file shows the mechanics. If the existing slash tests reveal a different way to open the menu (e.g. they set the draft to "/date" with a caret via fireEvent.change), copy it verbatim.

- [ ] **Step 2: Run to verify failure**

Run: `cd web && pnpm test:unit -- src/components/EditableBlockTree.test.tsx`
Expected: the new describe FAILS (`date` is not a command; no dialog renders). Existing tests still pass.

- [ ] **Step 3: Implement**

In `web/src/outline/slashCommands.ts`, append after `tomorrow` (keeping it the last entry):

```ts
  // "date" has no text transform: picking it strips the trigger and opens
  // the inline date picker (handled in BlockInput), which then splices the
  // [[daily-note]] link at the recorded offset.
  { name: "date", label: "link to a date…" },
```

In `docs/keyboard.md`, add after the `/today`, `/tomorrow` row:

```markdown
| `/date` | Pick a date from a calendar and insert a link to its daily note |
```

In `web/src/components/EditableBlockTree.tsx`, inside `BlockInput`:

Imports (top of file):

```ts
import { DatePickerPopup } from "./DatePickerPopup";
import { titleForDate } from "../replica/daily";
```

State, next to the other `useState` calls (~line 393):

```ts
  // Insertion offset for the /date picker; null = closed. The offset is
  // where the stripped "/" trigger sat. Any draft edit closes the picker
  // (onChange / applyKeyEdit below), so the offset can never go stale.
  const [datePickerAt, setDatePickerAt] = useState<number | null>(null);
```

In `pick()`, directly after the `/upload` special case (~line 551):

```ts
    // "/date": strip the trigger like /upload, but open the inline
    // focus-preserving picker instead of a native dialog — the textarea
    // keeps focus (the picker is mouse-down-only), so the eventual
    // insertion goes through the normal setText draft path.
    if (row.command === "date") {
      const at = ac.start - 1; // where the "/" was
      setAc(null);
      setAcSelected(0);
      setText(draft.slice(0, at) + draft.slice(caret), at);
      setDatePickerAt(at);
      return;
    }
```

The pick-date callback, next to `pick()`:

```ts
  const pickDate = (d: Date) => {
    if (datePickerAt === null) return;
    const at = Math.min(datePickerAt, draft.length);
    setDatePickerAt(null);
    const link = `[[${titleForDate(d)}]]`;
    setText(draft.slice(0, at) + link + draft.slice(at), at + link.length);
  };
```

In `onChange` (~line 568), first line of the body:

```ts
    setDatePickerAt(null); // any typed edit invalidates the stored offset
```

In `applyKeyEdit` (~line 500), first line of the body:

```ts
    setDatePickerAt(null);
```

In `onKeyDown` (~line 583), before the `decideEditorKey` call — the picker is shell-owned modal state, so it's consumed before the core policy runs (same reasoning as the display-line measurement above it):

```ts
    // The /date picker owns Escape while open; everything else falls
    // through to the normal policy (typing closes the picker via onChange).
    if (datePickerAt !== null && e.key === "Escape") {
      e.preventDefault();
      setDatePickerAt(null);
      return;
    }
```

In the render (~line 745), after `AutocompletePopup`:

```tsx
      {!readOnly && datePickerAt !== null && (
        <DatePickerPopup initial={new Date()} onPick={pickDate} />
      )}
```

- [ ] **Step 4: Run the full unit suite + checks**

Run: `cd web && pnpm test:unit && pnpm typecheck && pnpm check:fcis`
Expected: PASS. If `slashCommandsDocumented.test.ts` fails, the keyboard.md row is missing — fix it, don't touch the test.

- [ ] **Step 5: Commit**

```bash
git add web/src/outline/slashCommands.ts web/src/components/EditableBlockTree.tsx web/src/components/EditableBlockTree.test.tsx docs/keyboard.md
git commit -m "feat(web): /date slash command opens inline daily-note date picker (pkm-rw6w)"
```

---

### Task 4: E2E spec + full verification

**Files:**
- Create: `web/e2e/slash-dates.spec.ts`

**Interfaces:**
- Consumes: everything above, running against the real app.
- Produces: nothing downstream — final gate.

- [ ] **Step 1: Write the e2e spec**

Create `web/e2e/slash-dates.spec.ts`. Copy the `login`, `input`, `caretToEnd`, `afterPaint` helpers style from `web/e2e/edit.spec.ts:7-26` verbatim. **Never write into today's journal** (other specs assume it's empty) — create a unique page via `page.request.post("/api/pages", ...)` and edit there; see how `web/e2e/backlink-filter.spec.ts` or the linked-refs spec creates a POST page and navigates to it, and copy that navigation exactly. Read today's daily title off the rendered journal like `web/e2e/journal-references.spec.ts:26-33` does (`.journal-day .page-title a` innerText, after its sync wait) rather than re-deriving the format.

Two tests:

```ts
test("/today inserts a link to today's daily note", async ({ page }) => {
  // login; read todayTitle from the journal (journal-references idiom);
  // POST-create `slash dates ${Date.now()}`; navigate to it; focus the block;
  // type "/today" (fill/pressSequentially per edit.spec idiom);
  // pick the "link to today" option: page.getByRole("option", { name: "link to today" })
  //   .click() — popup rows pick on mousedown, click delivers it;
  // await expect(input(page)).toHaveValue(`[[${todayTitle}]]`);
});

test("/date picker inserts the clicked date's link", async ({ page }) => {
  // same setup with its own unique page; type "/date"; pick the
  // "link to a date…" option; the dialog appears:
  //   const dialog = page.getByRole("dialog", { name: "pick a date" });
  //   await expect(dialog).toBeVisible();
  // click day 15 of the current month:
  //   await dialog.getByRole("button", { name: "15", exact: true })
  //     .dispatchEvent("mousedown");
  // assert the inserted value: /^\[\[[A-Z][a-z]+ 15th, \d{4}\]\]$/
  //   await expect(input(page)).toHaveValue(/^\[\[[A-Z][a-z]+ 15th, \d{4}\]\]$/);
});
```

Write real bodies from the comments; the referenced specs supply every mechanic. Note: Playwright `.click()` on the day button also works (mousedown fires first and inserts; the button may unmount before mouseup — if that makes `.click()` flaky, use `dispatchEvent("mousedown")` as shown, which is the deterministic form).

- [ ] **Step 2: Run the new spec**

Run: `cd web && pnpm build && pnpm exec playwright test e2e/slash-dates.spec.ts`
(e2e serves `web/dist`, so build first; if the runner needs a port override, `E2E_PORT` avoids the 8975 clash — and never use port 8974, prod owns it.)
Expected: 2 passed.

- [ ] **Step 3: Full verification**

Run from the worktree root: `cd web && pnpm verify`
Expected: typecheck, lint, fcis, unit coverage thresholds, build, and the whole Playwright suite green. Known load-sensitive flake: `edit.spec.ts:308` — retry once before treating a failure there as yours; `lintConfig.test` and `link-reference.spec` are also known flakes.

- [ ] **Step 4: Server suite sanity check (no server changes expected)**

Run: `cd server && uv run pytest -q`
Expected: PASS untouched. (This feature is web-only; a failure here means something unexpected happened — report it.)

- [ ] **Step 5: Commit**

```bash
git add web/e2e/slash-dates.spec.ts
git commit -m "test(web): e2e coverage for /today, /tomorrow and /date shortcuts (pkm-rw6w)"
```
