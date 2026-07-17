# LaTeX Support (pkm-lr96) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `$$...$$` as KaTeX math — display mode when the expression is the whole block, inline mode mid-text.

**Architecture:** A new `math` segment kind in the hand-written tokenizer (`web/src/grammar/tokenize.ts`), dispatched by `InlineSegments.tsx` to a new `MathSpan` component that lazy-loads KaTeX exactly the way `MermaidDiagram.tsx` lazy-loads mermaid. Bundle budgets gain a `katexOwnedBytes` cap; the PWA precache gains a core KaTeX font subset. No server changes.

**Tech Stack:** React 18, Vite, vitest + @testing-library/react, Playwright, KaTeX (new dep), Workbox precache budgets.

**Spec:** `docs/superpowers/specs/2026-07-17-latex-support-design.md`

## Global Constraints

- Work on a branch (e.g. `feature/latex-support`) in a git worktree; run every command from the worktree root (parallel sessions switch the shared checkout's branch — check `git status -sb` before every commit).
- Push after every commit (`git push`); first push needs `-u origin feature/latex-support`.
- Delimiter is `$$...$$` ONLY. Single `$` is never math. Empty (`$$$$`) or whitespace-only (`$$ $$`) interiors are plain text. Unclosed `$$` is plain text.
- Display mode iff the block's entire text, after `trim()`, is exactly one `$$...$$` with no `$$` inside; everything else is inline mode.
- Math interior is verbatim TeX — no emphasis/links/wikilinks parsed inside. Code wins over math (`$$` inside inline code or fences stays literal).
- KaTeX errors → raw `$$...$$` source as plain text with a subtle tint (`.math-error`). Never blank output.
- KaTeX must be lazy-loaded: it must NOT appear in the eager entry chunk (`initialEntryBytes` has only ~16 KB headroom and must not grow by more than ~2 KB from the small eager `MathSpan` shell).
- Every new file with runtime behaviour declares `// pattern: Functional Core` or `// pattern: Imperative Shell` near the top (enforced by `pnpm check:fcis`).
- All web verification: `cd web && pnpm verify` (typecheck, lint, fcis, unit coverage ≥95% stmts, vite build with hard budgets, Playwright E2E). Server is untouched by this plan.
- Do NOT run dev servers or E2E on port 8974 (prod launchd service owns it). If the E2E port 8975 clashes, set `E2E_PORT=<free port>`.

---

### Task 1: Tokenizer — `math` segments

**Files:**
- Modify: `web/src/grammar/tokenize.ts`
- Test: `web/src/grammar/tokenize.test.ts`

**Interfaces:**
- Consumes: existing `tokenizeBlock(text: string): BlockSegment[]` and `tokenizeInline` internals.
- Produces: `InlineSegment` union gains `{ kind: "math"; tex: string; display: boolean }`. Task 2 renders it. `tex` excludes the `$$` delimiters; `display` is true only for the whole-block case.

- [ ] **Step 1: Write the failing tests**

Append to the top-level `describe("tokenizeBlock", ...)` block in `web/src/grammar/tokenize.test.ts` (same `expect(...).toEqual([...])` style as the existing tests):

```ts
  it("renders $$...$$ mid-text as inline math", () => {
    expect(tokenizeBlock("some text $$x^2$$ more text")).toEqual([
      { kind: "text", text: "some text " },
      { kind: "math", tex: "x^2", display: false },
      { kind: "text", text: " more text" },
    ]);
  });

  it("renders a whole-block $$...$$ as display math, tolerating surrounding whitespace", () => {
    expect(tokenizeBlock("$$\\sum_{i=1}^n i$$")).toEqual([
      { kind: "math", tex: "\\sum_{i=1}^n i", display: true },
    ]);
    expect(tokenizeBlock("  $$e^{i\\pi} = -1$$ \n")).toEqual([
      { kind: "math", tex: "e^{i\\pi} = -1", display: true },
    ]);
  });

  it("renders two $$...$$ in one block as two inline maths, not one display", () => {
    expect(tokenizeBlock("$$a$$ and $$b$$")).toEqual([
      { kind: "math", tex: "a", display: false },
      { kind: "text", text: " and " },
      { kind: "math", tex: "b", display: false },
    ]);
  });

  it("keeps unclosed $$ and empty/whitespace-only $$$$ as plain text", () => {
    expect(tokenizeBlock("cost is $$5 total")).toEqual([
      { kind: "text", text: "cost is $$5 total" },
    ]);
    expect(tokenizeBlock("$$$$")).toEqual([{ kind: "text", text: "$$$$" }]);
    expect(tokenizeBlock("a $$  $$ b")).toEqual([{ kind: "text", text: "a $$  $$ b" }]);
  });

  it("code wins over math: $$ inside inline code and fences stays literal", () => {
    expect(tokenizeBlock("`$$x$$`")).toEqual([
      { kind: "inline-code", code: "$$x$$" },
    ]);
    expect(tokenizeBlock("```\n$$x$$\n```")).toEqual([
      { kind: "code-block", lang: null, code: "$$x$$" },
    ]);
  });

  it("math interior is verbatim TeX: no emphasis or refs parsed inside", () => {
    expect(tokenizeBlock("see $$a **b** c$$")).toEqual([
      { kind: "text", text: "see " },
      { kind: "math", tex: "a **b** c", display: false },
    ]);
    expect(tokenizeBlock("$$[[Page]]$$")).toEqual([
      { kind: "math", tex: "[[Page]]", display: true },
    ]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm vitest run src/grammar/tokenize.test.ts`
Expected: the six new tests FAIL (math comes back as plain `text` segments); all pre-existing tests PASS.

- [ ] **Step 3: Implement**

In `web/src/grammar/tokenize.ts`:

(a) Extend the `InlineSegment` union (after the `link` member, before the emphasis member):

```ts
  | { kind: "math"; tex: string; display: boolean }
```

(b) Add a module-level constant near `QUERY_PREFIX`/`PDF_PREFIX`:

```ts
// A block whose ENTIRE trimmed text is one $$...$$ (no inner $$) renders in
// KaTeX display mode. Checked against raw text before any other grammar, so
// whole-block math is fully verbatim TeX.
const BLOCK_MATH_RE = /^\$\$([\s\S]+)\$\$$/;
```

(c) In `tokenizeInline`, insert this scan immediately BEFORE the emphasis loop (`let matchedEmphasis = false;`):

```ts
    if (ch === "$" && text.startsWith("$$", i)) {
      const close = text.indexOf("$$", i + 2);
      if (close !== -1 && close + 2 <= to
          && text.slice(i + 2, close).trim() !== "") {
        flushText();
        out.push({ kind: "math", tex: text.slice(i + 2, close), display: false });
        i = close + 2;
        continue;
      }
    }
```

(Positioning note: the scanner-token lookup earlier in the loop already consumed any inline-code token at its start offset, so a `$$` inside code is never reached — code wins. Scanner tokens that START inside the math interior are skipped because `i` jumps to `close + 2`, which is what makes the interior opaque.)

(d) At the top of `tokenizeBlock`, before the `scanGrammar` call, add the whole-block check:

```ts
  const blockMath = BLOCK_MATH_RE.exec(text.trim());
  if (blockMath && !blockMath[1].includes("$$") && blockMath[1].trim() !== "") {
    return [{ kind: "math", tex: blockMath[1], display: true }];
  }
```

(e) Update the file-header comment's list of render-side grammar to mention `$$ math`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm vitest run src/grammar/tokenize.test.ts`
Expected: ALL PASS. Also run `pnpm vitest run src/grammar/` to confirm no scanner/refs regressions.

- [ ] **Step 5: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: clean. (`InlineSegments.tsx`'s `switch` has no `default`, and the `Segment` component's return type check will fail ONLY if TS requires exhaustiveness — if `pnpm typecheck` reports the new `"math"` kind unhandled in `InlineSegments.tsx`, add a temporary `case "math": return null;` and note that Task 2 replaces it.)

- [ ] **Step 6: Commit and push**

```bash
git add src/grammar/tokenize.ts src/grammar/tokenize.test.ts src/components/InlineSegments.tsx
git commit -m "Tokenize \$\$...\$\$ into math segments (pkm-lr96)"
git push
```

---

### Task 2: KaTeX dependency, `MathSpan` component, dispatch, CSS

**Files:**
- Modify: `web/package.json` (via pnpm), `web/src/components/InlineSegments.tsx`, `web/src/styles.css`
- Create: `web/src/components/MathSpan.tsx`
- Test: `web/src/components/MathSpan.test.tsx`, `web/src/components/InlineSegments.test.tsx`

**Interfaces:**
- Consumes: `{ kind: "math"; tex: string; display: boolean }` from Task 1.
- Produces: `export function MathSpan({ tex, display }: { tex: string; display: boolean })`. Rendered markup: inline math → `<span class="math-inline">` wrapping KaTeX HTML; display math → `<span class="math-display">` (a span styled `display: block` — the block wrapper can be an `h1`–`h3`, so a `div` would be invalid nesting). Loading/error states show the raw `$$${tex}$$` text, error state with class `math-error`, loading with `math-loading`.

- [ ] **Step 1: Install KaTeX**

```bash
cd web && pnpm add katex && pnpm add -D @types/katex
```

Expected: `katex` in dependencies, `@types/katex` in devDependencies. (If `pnpm typecheck` later reports duplicate/conflicting types because katex now bundles its own, remove `@types/katex`.)

- [ ] **Step 2: Write the failing component tests**

Create `web/src/components/MathSpan.test.tsx`:

```tsx
import { render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MathSpan } from "./MathSpan";

// See MermaidDiagram.test.tsx: vi.mock factories are hoisted, so any
// closed-over variable must be named "mock*" for Vitest to rewire it safely.
const mockRenderToString = vi.fn();

vi.mock("katex", () => ({
  default: { renderToString: mockRenderToString },
}));

afterEach(() => {
  mockRenderToString.mockReset();
});

it("renders KaTeX HTML for valid inline TeX", async () => {
  mockRenderToString.mockReturnValue('<span class="katex">x²</span>');
  const { container } = render(<MathSpan tex="x^2" display={false} />);
  await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull());
  expect(mockRenderToString).toHaveBeenCalledWith("x^2",
    { displayMode: false, throwOnError: true });
  expect(container.querySelector("span.math-inline")).not.toBeNull();
  expect(container.querySelector(".math-display")).toBeNull();
});

it("renders display math in a block-level math-display wrapper", async () => {
  mockRenderToString.mockReturnValue('<span class="katex-display"><span class="katex">∑</span></span>');
  const { container } = render(<MathSpan tex={"\\sum_i i"} display={true} />);
  await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull());
  expect(mockRenderToString).toHaveBeenCalledWith("\\sum_i i",
    { displayMode: true, throwOnError: true });
  expect(container.querySelector("span.math-display")).not.toBeNull();
});

it("falls back to the raw delimited source when KaTeX throws", async () => {
  mockRenderToString.mockImplementation(() => { throw new Error("ParseError"); });
  const { container } = render(<MathSpan tex={"\\frac{"} display={false} />);
  await waitFor(() => expect(container.querySelector(".math-error")).not.toBeNull());
  expect(container.textContent).toBe("$$\\frac{$$");
  expect(container.querySelector(".katex")).toBeNull();
});

it("shows the raw source while KaTeX is loading (no blank flash)", () => {
  mockRenderToString.mockReturnValue('<span class="katex">x</span>');
  const { container } = render(<MathSpan tex="x" display={false} />);
  // synchronously after mount, before the lazy import resolves
  expect(container.textContent).toBe("$$x$$");
});
```

Append to `web/src/components/InlineSegments.test.tsx` (uses the REAL katex — it's a pure-JS renderer and works under jsdom; follow the file's existing render-helper conventions for context providers if plain `render` fails):

```tsx
it("dispatches math segments to MathSpan and renders KaTeX output", async () => {
  const { container } = render(
    <InlineSegments segments={[{ kind: "math", tex: "x^2", display: false }]} />,
  );
  expect(container.textContent).toBe("$$x^2$$"); // loading fallback
  await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull());
});
```

NOTE: `InlineSegments.test.tsx` does not currently mock `katex`, so the real one loads — do not add a `vi.mock("katex", ...)` there.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && pnpm vitest run src/components/MathSpan.test.tsx src/components/InlineSegments.test.tsx`
Expected: FAIL — `MathSpan.tsx` does not exist; the InlineSegments test fails (math case unhandled or temporary `return null`).

- [ ] **Step 4: Implement `MathSpan.tsx`**

Create `web/src/components/MathSpan.tsx`:

```tsx
// pattern: Imperative Shell
// KaTeX (~280KB + CSS/fonts) is loaded lazily via dynamic import() on first
// math render, mirroring MermaidDiagram.tsx, so blocks without math never
// pay for it. Vite splits katex and its CSS into their own chunk.
//
// katex.renderToString() output is library-generated markup (never raw
// user/server text through dangerouslySetInnerHTML) -- the same trust
// boundary MermaidDiagram's SVG and CodeBlock's hljs output cross. KaTeX's
// default trust:false additionally refuses \href and friends.
import { useEffect, useState } from "react";

type KatexLib = typeof import("katex").default;

type RenderState =
  | { status: "loading" }
  | { status: "ok"; html: string }
  | { status: "error" };

// Loaded once for the whole page, shared by every math span on it --
// module-level-cache-Promise style, same as MermaidDiagram's loadMermaid().
// The CSS import rides along so the katex styles/fonts join the lazy chunk
// instead of the eager entry (initialEntryBytes headroom is ~16KB).
let katexPromise: Promise<KatexLib> | null = null;

function loadKatex(): Promise<KatexLib> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import("katex"),
      import("katex/dist/katex.min.css"),
    ]).then(([mod]) => mod.default);
    // A failed chunk load shouldn't wedge every future math span.
    katexPromise.catch(() => { katexPromise = null; });
  }
  return katexPromise;
}

export function MathSpan({ tex, display }: { tex: string; display: boolean }) {
  const [state, setState] = useState<RenderState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    loadKatex().then(
      (katex) => {
        try {
          const html = katex.renderToString(tex,
            { displayMode: display, throwOnError: true });
          if (alive) setState({ status: "ok", html });
        } catch {
          // Invalid TeX: degrade to the raw-source fallback below.
          if (alive) setState({ status: "error" });
        }
      },
      () => { if (alive) setState({ status: "error" }); },
    );
    return () => { alive = false; };
  }, [tex, display]);

  // math-display is a block-styled <span>, not a <div>: the segment can sit
  // inside an h1-h3 block wrapper where a div is invalid nesting.
  const cls = display ? "math-display" : "math-inline";
  if (state.status !== "ok") {
    const stateCls = state.status === "error" ? " math-error" : " math-loading";
    return <span className={cls + stateCls}>{`$$${tex}$$`}</span>;
  }
  return (
    <span
      className={cls}
      // library-generated markup (never raw user/server text) -- see the
      // trust-boundary note in this file's header comment.
      dangerouslySetInnerHTML={{ __html: state.html }}
    />
  );
}
```

- [ ] **Step 5: Wire the dispatch**

In `web/src/components/InlineSegments.tsx`:
- Add `import { MathSpan } from "./MathSpan";` (alphabetical with the other imports).
- In `Segment`'s switch, after `case "inline-code":`, add (replacing any temporary `return null` from Task 1):

```tsx
    case "math":
      return <MathSpan tex={seg.tex} display={seg.display} />;
```

- [ ] **Step 6: Add CSS**

In `web/src/styles.css`, next to the `.mermaid-diagram-*` rules:

```css
.math-display { display: block; overflow-x: auto; }
.math-error { background: var(--color-bg-subtle); border-radius: var(--radius-control); padding: 0 3px; color: var(--color-text-muted); }
```

(KaTeX's own `.katex-display` handles centering/margins; `overflow-x` stops a wide equation from widening the outline column. `.math-loading` intentionally has no rule — the raw source renders as normal text until the chunk arrives.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd web && pnpm vitest run src/components/MathSpan.test.tsx src/components/InlineSegments.test.tsx`
Expected: ALL PASS.

- [ ] **Step 8: Full unit suite + typecheck + fcis**

Run: `cd web && pnpm typecheck && pnpm check:fcis && pnpm test:unit`
Expected: clean; coverage thresholds are checked later by `pnpm verify`.

- [ ] **Step 9: Commit and push**

```bash
git add package.json ../pnpm-lock.yaml src/components/MathSpan.tsx src/components/MathSpan.test.tsx src/components/InlineSegments.tsx src/components/InlineSegments.test.tsx src/styles.css
git commit -m "Render math segments with lazy-loaded KaTeX (pkm-lr96)"
git push
```

(If the lockfile lives at `web/pnpm-lock.yaml` rather than the repo root, adjust the path — check `git status -sb` first as always.)

---

### Task 3: Bundle budget cap + PWA font precache

**Files:**
- Modify: `web/tooling/buildBudgets.ts`, `web/tooling/viteBudgetPlugin.ts`, `web/tooling/budgets.json`, `web/vite.config.ts`

**Interfaces:**
- Consumes: the built output of Tasks 1–2 (katex must appear as its own lazy chunk).
- Produces: `BuildBudgets.katexOwnedBytes: number`, `OwnedModuleSets.katex: ReadonlySet<string>`, a `katexOwnedBytes` check in `evaluateBundleBudgets`, and Workbox precaching of the core KaTeX woff2 fonts.

- [ ] **Step 1: Add the katex budget wiring**

In `web/tooling/buildBudgets.ts`:

(a) `BuildBudgets` interface, after `pdfjsOwnedBytes`:

```ts
  /** Raw bytes of chunks wholly owned by the lazy KaTeX module graph. */
  katexOwnedBytes: number;
```

(b) `OwnedModuleSets`, after `pdfjs`:

```ts
  katex: ReadonlySet<string>;
```

(c) In `evaluateBundleBudgets`'s `checks` array, after the `pdfjsOwnedBytes` check:

```ts
    check("katexOwnedBytes", budgets.katexOwnedBytes,
      ownedChunkBytes(chunks, owned.katex)),
```

In `web/tooling/viteBudgetPlugin.ts`:

(d) After `isPdfjsSeed`:

```ts
/** KaTeX graph seeds: katex package modules under node_modules. */
const isKatexSeed = (id: string): boolean =>
  id.includes("node_modules") && /[\\/]katex[\\/]/.test(id);
```

(e) In `budgetPlugin`'s `generateBundle`, extend `owned`:

```ts
      const owned = {
        mermaid: collectOwned(graph, isMermaidSeed),
        pdfjs: collectOwned(graph, isPdfjsSeed),
        katex: collectOwned(graph, isKatexSeed),
      };
```

In `web/tooling/budgets.json`:

(f) Add `"katexOwnedBytes": 1` to `limits` (the deliberately-failing placeholder convention used when pdfjsOwnedBytes was introduced — the first build FAILS on it and prints the measured actual).

- [ ] **Step 2: Precache the core KaTeX fonts**

In `web/vite.config.ts`, `workbox.globPatterns` becomes:

```ts
        globPatterns: [
          "**/*.{js,mjs,css,html,ico,png,svg,wasm}",
          // Offline math: the core KaTeX faces (Main, Math, AMS, Size1-4).
          // Exotic faces (Fraktur, Script, Typewriter, ...) load on demand
          // online and fall back to system fonts offline.
          "**/KaTeX_{Main,Math,AMS,Size1,Size2,Size3,Size4}-*.woff2",
        ],
```

- [ ] **Step 3: Measure**

Run: `cd web && pnpm build`
Expected: build FAILS on `katexOwnedBytes: <actual> / 1` — that is the measurement run. Record from the printed bundle report: katexOwnedBytes actual, totalOutputBytes actual, initialEntryBytes actual; and from the precache report: precacheBytes and precacheEntries actuals.

SANITY CHECKS before rebaselining:
- `initialEntryBytes` must be within ~2 KB of the pre-change 445507. If it jumped by ~280 KB, katex leaked into the eager entry (a static `import katex` somewhere) — fix that, do not bump the limit.
- `katexOwnedBytes` actual should be roughly 250–350 KB (katex.min.js order of magnitude). Zero means the chunk was not recognized as owned — investigate the seed regex.

- [ ] **Step 4: Rebaseline budgets.json**

Set each limit that changed to `actual + ~4.5%` headroom (entries: `actual + 3`), matching the existing convention. Expected to need updating: `katexOwnedBytes` (placeholder → real), `totalOutputBytes` (katex js + css + ~60 emitted font files ≈ +1.4 MB), `precacheBytes` (+ katex js/css + ~11 woff2 fonts), `precacheEntries` (+ katex chunk, css, ~11 fonts). `initialEntryBytes` and `largestAssetBytes` should be unchanged — leave them alone unless the report shows a small drift as per the sanity checks above.

For every limit changed, update the matching `rationale` entry in `budgets.json`: what grew, measured actual, date 2026-07-17, "actual + ~4.5% headroom" (mirror the pdfjsOwnedBytes entry's wording), and set `"measuredOn": "2026-07-17"`.

- [ ] **Step 5: Verify the build is green**

Run: `cd web && pnpm build`
Expected: PASS; bundle report shows `katexOwnedBytes: ok`, precache report `ok`. Confirm in the output listing that a `katex`-named lazy chunk and its CSS exist, and that woff2 files were emitted to `dist/app-assets/`.

- [ ] **Step 6: Commit and push**

```bash
git add tooling/buildBudgets.ts tooling/viteBudgetPlugin.ts tooling/budgets.json vite.config.ts
git commit -m "Cap KaTeX chunk bytes and precache core math fonts (pkm-lr96)"
git push
```

---

### Task 4: E2E test + full verification + bean wrap-up

**Files:**
- Create: `web/e2e/math.spec.ts`
- Modify: `.beans/pkm-lr96--latex-support.md`

**Interfaces:**
- Consumes: the running app with Tasks 1–3 built in; `web/e2e/fixtures.ts` (`test`, `expect`), the login/input helpers pattern from `edit.spec.ts`.
- Produces: nothing downstream; this is the verification gate.

- [ ] **Step 1: Write the E2E spec**

Create `web/e2e/math.spec.ts`:

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

test("renders $$...$$ as KaTeX, inline and display (pkm-lr96)", async ({ page }) => {
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

  await input(page).fill("inline math $$x^2 + y^2 = z^2$$ mid-sentence");
  await input(page).press("Enter");
  await input(page).fill("$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$");
  await input(page).press("Escape"); // blur: leaves edit mode, renders math

  // inline: KaTeX output flows inside the block text, not display mode
  const inlineBlock = page.locator(".block-text", { hasText: "mid-sentence" });
  await expect(inlineBlock.locator(".math-inline .katex")).toBeVisible();
  await expect(inlineBlock.locator(".katex-display")).toHaveCount(0);

  // display: the whole-block expression renders in KaTeX display mode
  const displayBlock = page.locator(".block-text .math-display");
  await expect(displayBlock.locator(".katex-display")).toBeVisible();

  // error fallback: invalid TeX shows the raw source, tinted, not a crash
  await caretToEnd(page);
  await input(page).press("Enter");
  await input(page).fill("$$\\frac{$$ broken");
  await input(page).press("Escape");
  const errorBlock = page.locator(".block-text", { hasText: "broken" });
  await expect(errorBlock.locator(".math-error")).toBeVisible();
  await expect(errorBlock.locator(".math-error")).toHaveText("$$\\frac{$$");
});
```

NOTE on the error case: the raw text `$$\frac{$$ broken` tokenizes as inline math `\frac{` (first `$$` pair) + text ` broken` — a genuinely invalid TeX fragment reaching KaTeX, which throws, exercising the fallback.

- [ ] **Step 2: Run the E2E spec**

Run: `cd web && pnpm build && node tooling/runPlaywright.mjs e2e/math.spec.ts`
(If port 8975 is taken by another session: `E2E_PORT=8985 node tooling/runPlaywright.mjs e2e/math.spec.ts`.)
Expected: PASS.

- [ ] **Step 3: Full verification**

Run: `cd web && pnpm verify`
Expected: typecheck, lint, check:fcis, unit coverage (≥95% statements — MathSpan and the tokenizer additions are covered by Tasks 1–2 tests), vite build within budgets, and the full Playwright suite ALL PASS. Fix anything that fails before proceeding.

- [ ] **Step 4: Update the bean**

Add to `.beans/pkm-lr96--latex-support.md` a `## Summary of Changes` section (tokenizer math segments; lazy KaTeX MathSpan; budgets + font precache; unit + E2E coverage; spec/plan doc links). Do NOT mark the bean completed yet — that happens at merge time via the finishing-a-development-branch skill.

- [ ] **Step 5: Commit and push**

```bash
git add e2e/math.spec.ts ../.beans/pkm-lr96--latex-support.md
git commit -m "E2E-verify KaTeX rendering and update bean (pkm-lr96)"
git push
```

---

### After all tasks

Use the superpowers:finishing-a-development-branch skill: merge with `git merge --no-ff feature/latex-support`, mark pkm-lr96 completed, push. Prod deploy (if requested) uses `~/.config/pkm/app/deploy/update.sh` — never the dev checkout's copy; note update.sh needs `CI=true` when pnpm purges modules.
