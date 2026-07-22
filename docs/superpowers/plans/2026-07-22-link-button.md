# Unlinked Reference Link Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Link button to each unlinked-reference result so one click creates a canonical page reference safely, removes the unlinked result, and refreshes Linked References.

**Architecture:** A syntax-aware Functional Core transforms block text while React Imperative Shell components enqueue the existing `update_text` operation and coordinate reference-section refreshes. Explicit snapshot hashes protect against stale writes, and the existing offline queue remains the only write path.

**Tech Stack:** React 18, TypeScript 5.9, Vitest, Testing Library, Playwright, SQLite-WASM replica queue, FastAPI read APIs.

## Global Constraints

- Work only in `/Users/arthur/code/llm/pkm/.worktrees/pkm-965i-link-button` on `feature/pkm-965i-link-button`.
- Follow test-driven development: add a failing test, observe the expected failure, implement only enough to pass, then commit.
- Every new runtime TypeScript file must declare `// pattern: Functional Core` or `// pattern: Imperative Shell` near the top.
- Do not add a server endpoint, server response field, operation type, or dependency.
- Match source text case-insensitively but always emit the canonical, case-sensitive page title.
- Link only the first eligible plain occurrence. If no plain occurrence is eligible but a Markdown link label or URL matches, preserve the Markdown and append one canonical tag.
- Keep existing references, tags, block references, inline code, fenced code, and Markdown images unchanged.
- Use `Sync.enqueue()` with `update_text`; never call `/api/ops` directly.
- Update `.beans/pkm-965i--link-button.md` as checklist items are completed and include it in the relevant commits.
- Push every commit to `origin/feature/pkm-965i-link-button`.

## File Structure

- Create `web/src/grammar/markdown.ts`: shared pure Markdown link/image span scanner.
- Create `web/src/grammar/linkReference.ts`: pure unlinked-reference transformation.
- Create `web/src/grammar/linkReference.test.ts`: transformation contract tests.
- Modify `web/src/grammar/tokenize.ts`: consume the shared Markdown scanner without changing rendering.
- Modify `web/src/replica/queue.ts` and `web/src/replica/queue.test.ts`: preserve explicit snapshot hashes.
- Modify `web/src/components/UnlinkedSection.tsx` and `web/src/components/sections.test.tsx`: per-result Link action and lifecycle.
- Modify `web/src/components/BacklinksSection.tsx`: replacement refresh with retry and pagination/filter preservation.
- Modify `web/src/views/PageView.tsx` and `web/src/views/PageView.test.tsx`: canonical title and cross-section refresh generation.
- Modify `web/src/styles.css` and `web/src/styles.test.ts`: compact action layout.
- Create `web/e2e/link-reference.spec.ts`: plain-text and Markdown browser coverage.

---

### Task 1: Add the Syntax-Aware Transformation Core

**Files:**
- Create: `web/src/grammar/markdown.ts`
- Create: `web/src/grammar/linkReference.ts`
- Create: `web/src/grammar/linkReference.test.ts`
- Modify: `web/src/grammar/tokenize.ts:8-80,140-164`
- Test: `web/src/grammar/tokenize.test.ts`

**Interfaces:**
- Produces: `scanMarkdownLinkAt(text: string, start: number): MarkdownSpan | null`
- Produces: `scanMarkdownLinks(text: string): readonly MarkdownSpan[]`
- Produces: `linkUnlinkedReference(text: string, canonicalTitle: string): LinkReferenceResult`
- `LinkReferenceResult` is `{ status: "linked"; text: string; match: "plain" | "markdown" } | { status: "no-safe-match" }`.

- [ ] **Step 1: Write the failing transformation tests**

Create `web/src/grammar/linkReference.test.ts` with explicit examples:

```ts
import { describe, expect, test } from "vitest";
import { linkUnlinkedReference } from "./linkReference";

const linked = (text: string, title: string) =>
  linkUnlinkedReference(text, title);

describe("linkUnlinkedReference", () => {
  test("links the first differently cased plain occurrence using canonical casing", () => {
    expect(linked("Acme created Acme", "ACME")).toEqual({
      status: "linked",
      match: "plain",
      text: "[[ACME]] created Acme",
    });
  });

  test("enforces alphanumeric title boundaries", () => {
    expect(linked("MegaACME ACMEworks Acme works", "ACME")).toEqual({
      status: "linked",
      match: "plain",
      text: "MegaACME ACMEworks [[ACME]] works",
    });
  });

  test("supports multi-word and punctuation-edged titles", () => {
    expect(linked("Machine Learning notes", "Machine Learning")).toMatchObject({
      status: "linked", text: "[[Machine Learning]] notes",
    });
    expect(linked("read C++ today", "C++")).toMatchObject({
      status: "linked", text: "read [[C++]] today",
    });
  });

  test.each([
    ["[ACME study](https://example.test)", "label"],
    ["[A study](https://acme.test/study)", "destination"],
  ])("appends a canonical tag for a Markdown %s match", (text) => {
    expect(linked(text, "ACME")).toEqual({
      status: "linked", match: "markdown", text: `${text} #[[ACME]]`,
    });
  });

  test("prefers an eligible plain occurrence over a Markdown match", () => {
    expect(linked("[ACME](https://acme.test) by Acme", "ACME")).toEqual({
      status: "linked",
      match: "plain",
      text: "[ACME](https://acme.test) by [[ACME]]",
    });
  });

  test("protects references, tags, code, and images", () => {
    const text = "[[ACME]] #[[ACME]] #ACME ((ACME12)) `ACME` ```ACME``` ![ACME](acme.png)";
    expect(linked(text, "ACME")).toEqual({ status: "no-safe-match" });
  });

  test("does not treat Markdown images as fallback links", () => {
    expect(linked("![ACME](https://acme.test/image.png)", "ACME"))
      .toEqual({ status: "no-safe-match" });
  });

  test("adds no duplicate separator when a Markdown block ends in whitespace", () => {
    expect(linked("[ACME](https://example.test) ", "ACME")).toMatchObject({
      text: "[ACME](https://example.test) #[[ACME]]",
    });
  });

  test("returns no-safe-match for an empty title or absent title", () => {
    expect(linked("ACME", "")).toEqual({ status: "no-safe-match" });
    expect(linked("unrelated", "ACME")).toEqual({ status: "no-safe-match" });
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
cd web
pnpm exec vitest run src/grammar/linkReference.test.ts src/grammar/tokenize.test.ts
```

Expected: `linkReference.test.ts` fails because `./linkReference` does not exist; existing tokenizer tests still pass.

- [ ] **Step 3: Extract the shared Markdown scanner**

Create `web/src/grammar/markdown.ts`:

```ts
// pattern: Functional Core
import type { Span } from "./scan";

export interface MarkdownSpan extends Span {
  kind: "link" | "image";
  label: Span;
  destination: Span;
}

export function scanMarkdownLinkAt(
  text: string,
  start: number,
): MarkdownSpan | null {
  const image = text[start] === "!";
  const open = image ? start + 1 : start;
  if (text[open] !== "[" || text.startsWith("[[", open)) return null;

  let depth = 1;
  let cursor = open + 1;
  while (cursor < text.length && depth > 0) {
    if (text[cursor] === "\n") return null;
    if (text[cursor] === "[") depth += 1;
    else if (text[cursor] === "]") depth -= 1;
    cursor += 1;
  }
  if (depth !== 0 || text[cursor] !== "(") return null;

  const close = text.indexOf(")", cursor + 1);
  if (close === -1 || text.slice(cursor + 1, close).includes("\n")) return null;
  return {
    kind: image ? "image" : "link",
    start,
    end: close + 1,
    label: { start: open + 1, end: cursor - 1 },
    destination: { start: cursor + 1, end: close },
  };
}

export function scanMarkdownLinks(text: string): readonly MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const candidate = text[cursor] === "!" && text[cursor + 1] === "["
      ? scanMarkdownLinkAt(text, cursor)
      : text[cursor] === "[" && !text.startsWith("[[", cursor)
        ? scanMarkdownLinkAt(text, cursor)
        : null;
    if (candidate) {
      spans.push(candidate);
      cursor = candidate.end;
    } else cursor += 1;
  }
  return spans;
}
```

In `web/src/grammar/tokenize.ts`, import `scanMarkdownLinkAt`, delete the private `scanMarkdownLink`, and replace the image/link branches with:

```ts
import { scanMarkdownLinkAt } from "./markdown";

// inside tokenizeInline()
if (ch === "!" && text.startsWith("![", i)) {
  const link = scanMarkdownLinkAt(text, i);
  if (link?.kind === "image" && link.end <= to) {
    flushText();
    out.push({
      kind: "image",
      alt: text.slice(link.label.start, link.label.end),
      src: text.slice(link.destination.start, link.destination.end),
    });
    i = link.end;
    continue;
  }
}
if (ch === "[" && !text.startsWith("[[", i)) {
  const link = scanMarkdownLinkAt(text, i);
  if (link?.kind === "link" && link.end <= to) {
    flushText();
    out.push({
      kind: "link",
      text: text.slice(link.label.start, link.label.end),
      href: text.slice(link.destination.start, link.destination.end),
    });
    i = link.end;
    continue;
  }
}
```

- [ ] **Step 4: Implement the pure reference transformation**

Create `web/src/grammar/linkReference.ts`:

```ts
// pattern: Functional Core
import { scanMarkdownLinks, type MarkdownSpan } from "./markdown";
import { scanGrammar, type Span } from "./scan";

export type LinkReferenceResult =
  | { status: "linked"; text: string; match: "plain" | "markdown" }
  | { status: "no-safe-match" };

const ALNUM = /[\p{L}\p{N}]/u;
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const overlaps = (left: Span, right: Span): boolean =>
  left.start < right.end && right.start < left.end;
const contains = (outer: Span, inner: Span): boolean =>
  outer.start <= inner.start && inner.end <= outer.end;
const firstCodePoint = (value: string): string => [...value][0] ?? "";
const lastCodePoint = (value: string): string => [...value].at(-1) ?? "";
const codePointBefore = (value: string, offset: number): string =>
  [...value.slice(0, offset)].at(-1) ?? "";
const codePointAfter = (value: string, offset: number): string =>
  [...value.slice(offset)][0] ?? "";

function candidates(text: string, title: string): Span[] {
  const startsAlnum = ALNUM.test(firstCodePoint(title));
  const endsAlnum = ALNUM.test(lastCodePoint(title));
  const found: Span[] = [];
  for (const match of text.matchAll(new RegExp(escapeRegExp(title), "giu"))) {
    const start = match.index;
    const end = start + match[0].length;
    if (startsAlnum && ALNUM.test(codePointBefore(text, start))) continue;
    if (endsAlnum && ALNUM.test(codePointAfter(text, end))) continue;
    found.push({ start, end });
  }
  return found;
}

const matchingMarkdown = (
  spans: readonly MarkdownSpan[],
  found: readonly Span[],
  grammarProtected: readonly Span[],
): boolean => spans.some((markdown) =>
  markdown.kind === "link"
  && !grammarProtected.some((span) => overlaps(markdown, span)
    && (span.start <= markdown.start || markdown.end <= span.end))
  && found.some((candidate) =>
    !grammarProtected.some((span) => overlaps(candidate, span))
    && (contains(markdown.label, candidate)
      || contains(markdown.destination, candidate))),
);

export function linkUnlinkedReference(
  text: string,
  canonicalTitle: string,
): LinkReferenceResult {
  if (canonicalTitle.length === 0) return { status: "no-safe-match" };

  const found = candidates(text, canonicalTitle);
  const grammarProtected = scanGrammar(text).tokens.filter((token) =>
    token.kind === "page-ref" || token.kind === "hashtag"
      || token.kind === "block-ref" || token.kind === "inline-code"
      || token.kind === "code-fence");
  const markdown = scanMarkdownLinks(text);
  const allProtected: readonly Span[] = [...grammarProtected, ...markdown];
  const plain = found.find((candidate) =>
    !allProtected.some((span) => overlaps(candidate, span)));

  if (plain) {
    return {
      status: "linked",
      match: "plain",
      text: `${text.slice(0, plain.start)}[[${canonicalTitle}]]${text.slice(plain.end)}`,
    };
  }
  if (matchingMarkdown(markdown, found, grammarProtected)) {
    const separator = /\s$/u.test(text) ? "" : " ";
    return {
      status: "linked",
      match: "markdown",
      text: `${text}${separator}#[[${canonicalTitle}]]`,
    };
  }
  return { status: "no-safe-match" };
}
```

During implementation, keep the public contract above but simplify internal helpers if tests expose a clearer implementation. Do not broaden Markdown parsing beyond the renderer's current rules.

- [ ] **Step 5: Run the grammar tests and confirm GREEN**

Run:

```bash
cd web
pnpm exec vitest run src/grammar/linkReference.test.ts src/grammar/tokenize.test.ts
pnpm typecheck
pnpm check:fcis
```

Expected: all focused tests pass, TypeScript reports no errors, and FCIS reports no boundary violations.

- [ ] **Step 6: Commit and push Task 1**

```bash
git add web/src/grammar/markdown.ts web/src/grammar/linkReference.ts \
  web/src/grammar/linkReference.test.ts web/src/grammar/tokenize.ts
git commit -m "feat(web): add unlinked reference transform"
git push
```

---

### Task 2: Preserve Explicit Snapshot Hashes

**Files:**
- Modify: `web/src/replica/queue.ts:25-44`
- Modify: `web/src/replica/queue.test.ts:18-41`

**Interfaces:**
- Consumes: existing optional `UpdateTextOp.base_text_hash`.
- Produces: queue behavior that preserves a supplied hash and derives one only when absent.

- [ ] **Step 1: Add the failing queue regression test**

Add inside `describe("enqueueBatch")` in `web/src/replica/queue.test.ts`:

```ts
test("preserves an explicit base_text_hash", () => {
  enqueueBatch(t.db, [{
    op: "update_text",
    uid: "uid_q1",
    text: "linked snapshot",
    base_text_hash: "snapshot-hash",
  }], 99, "batch-explicit");

  const ops = JSON.parse(t.db.select<{ ops_json: string }>(
    "SELECT ops_json FROM pending_ops",
  )[0].ops_json) as UpdateTextOp[];
  expect(ops[0].base_text_hash).toBe("snapshot-hash");
  expect(t.db.select("SELECT text FROM blocks WHERE uid='uid_q1'"))
    .toEqual([{ text: "linked snapshot" }]);
});
```

- [ ] **Step 2: Run the test and confirm RED**

```bash
cd web
pnpm exec vitest run src/replica/queue.test.ts
```

Expected: the new assertion receives `sha256Hex("original text")` instead of `"snapshot-hash"`.

- [ ] **Step 3: Preserve explicit hashes in `enqueueBatch`**

Replace the update augmentation condition in `web/src/replica/queue.ts` with:

```ts
if (op.op === "update_text" && op.base_text_hash === undefined) {
  const base = currentText(db, op.uid);
  if (base !== null) {
    wireOp = { ...op, base_text_hash: sha256Hex(base) } as UpdateTextOp;
  }
}
```

Use an `undefined` check, not truthiness. Leave optimistic application and unknown-block behavior unchanged.

- [ ] **Step 4: Run queue tests and confirm GREEN**

```bash
cd web
pnpm exec vitest run src/replica/queue.test.ts
```

Expected: all queue tests pass, including the existing derived-hash and chained-edit tests.

- [ ] **Step 5: Commit and push Task 2**

```bash
git add web/src/replica/queue.ts web/src/replica/queue.test.ts
git commit -m "fix(web): preserve explicit update text hash"
git push
```

---

### Task 3: Add the Per-Result Link Action

**Files:**
- Modify: `web/src/components/UnlinkedSection.tsx`
- Modify: `web/src/components/sections.test.tsx`

**Interfaces:**
- Consumes: `linkUnlinkedReference()`, `sha256Hex()`, `useSync()`, and `WriteTicket` outcomes.
- Produces: `UnlinkedSection({ title, onLinked? })`, where `onLinked` fires once after server delivery succeeds.

- [ ] **Step 1: Add controlled-ticket test utilities and failing component tests**

In `web/src/components/sections.test.tsx`, import `act`, `SyncContext`, `makeSync`, `sha256Hex`, and the write outcome types. Add this local helper:

```ts
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function unlinkedPayload() {
  return {
    groups: [{ page_id: 2, page_title: "Source", items: [
      { uid: "uid_u1", text: "Acme created it" },
      { uid: "uid_u2", text: "Acme reviewed it" },
    ] }],
    total: 2,
  };
}
```

Add tests that render `UnlinkedSection` inside `SyncContext.Provider` and assert:

```ts
it("queues a canonical update with the snapshot hash and source scope", async () => {
  stubFetch([["/api/unlinked?title=ACME", unlinkedPayload()]]);
  const sync = makeSync();
  render(
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <UnlinkedSection title="ACME" />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  fireEvent.click(screen.getByText(/unlinked references/i));
  fireEvent.click((await screen.findAllByRole("button", { name: "Link" }))[0]);
  await vi.waitFor(() => expect(sync.sent).toHaveLength(1));
  expect(sync.sent[0]).toEqual([{
    op: "update_text",
    uid: "uid_u1",
    text: "[[ACME]] created it",
    base_text_hash: sha256Hex("Acme created it"),
  }]);
  expect(sync.tickets[0].scope).toEqual(["page", "Source"]);
});
```

Add named tests for these exact contracts:

- `renders one Link button per result and disables only the pending result`: return unresolved write promises for `uid_u1`, click its button, and assert one `Linking…` button plus one enabled `Link` button.
- `disables Link with the read-only reason as its tooltip`: render `makeSync("reconnecting", { canEdit: false, readOnlyReason: "Replica unavailable" })` and assert both buttons are disabled with that title.
- `hides a durably persisted item and notifies only after delivery`: resolve `settled` as persisted, assert the first text and its empty group are absent while `onLinked` is untouched, then resolve `delivered` and assert one callback.
- `retains the item when local persistence fails`: resolve `settled` as `{ status: "failed", error: new Error("disk full") }`, assert the text remains, the error is visible, and Link is enabled.
- `restores the item and permits retry after delivery fails`: resolve persistence, verify the item hides, resolve delivery as failed, verify it returns in its original group, then click Link again and assert a second enqueue.
- `reports no-safe-match without enqueueing`: use the block text `` `ACME` ``, click Link, and assert the exact error `No linkable occurrence found.` and zero enqueue calls.

For controlled outcomes, start with `const sync = makeSync()`, replace `sync.enqueue` with a `vi.fn` returning a ticket backed by `deferred<WriteOutcome>()` and `deferred<DeliveryOutcome>()`, and inspect that mock's arguments. Import both outcome types and `WriteTicket` from `../sync/opQueue`. Do not change the shared `makeSync` helper solely for these tests.

- [ ] **Step 2: Run the component tests and confirm RED**

```bash
cd web
pnpm exec vitest run src/components/sections.test.tsx
```

Expected: Link buttons are absent and `UnlinkedSection` does not accept `onLinked`.

- [ ] **Step 3: Implement the write lifecycle in `UnlinkedSection`**

Change the component signature and add imports:

```ts
import { useRef, useState } from "react";
import type { UpdateTextOp } from "../api/ops";
import { linkUnlinkedReference } from "../grammar/linkReference";
import { sha256Hex } from "../replica/sha256";
import { useSync } from "../sync/SyncProvider";

type ItemStatus =
  | { state: "pending" }
  | { state: "error"; message: string };

export function UnlinkedSection({ title, onLinked }: {
  title: string;
  onLinked?: () => void;
}) {
```

Inside the component, add:

```ts
const sync = useSync();
const [itemStatus, setItemStatus] = useState<Record<string, ItemStatus>>({});
const [hiddenUids, setHiddenUids] = useState<ReadonlySet<string>>(new Set());
const inFlight = useRef(new Set<string>());

const setStatus = (uid: string, status?: ItemStatus) => {
  setItemStatus((current) => {
    const next = { ...current };
    if (status) next[uid] = status;
    else delete next[uid];
    return next;
  });
};

const linkItem = async (group: BlockGroup, item: BlockGroup["items"][number]) => {
  if (!sync.canEdit || inFlight.current.has(item.uid)) return;
  const transformed = linkUnlinkedReference(item.text, title);
  if (transformed.status === "no-safe-match") {
    setStatus(item.uid, { state: "error", message: "No linkable occurrence found." });
    return;
  }

  inFlight.current.add(item.uid);
  setStatus(item.uid, { state: "pending" });
  const op: UpdateTextOp = {
    op: "update_text",
    uid: item.uid,
    text: transformed.text,
    base_text_hash: sha256Hex(item.text),
  };

  let ticket: WriteTicket;
  try {
    ticket = sync.enqueue([op], ["page", group.page_title]);
  } catch (error: unknown) {
    inFlight.current.delete(item.uid);
    setStatus(item.uid, { state: "error", message: String(error) });
    return;
  }

  const settled = await ticket.settled;
  if (settled.status === "failed") {
    inFlight.current.delete(item.uid);
    setStatus(item.uid, { state: "error", message: String(settled.error) });
    return;
  }
  setHiddenUids((current) => new Set(current).add(item.uid));

  const delivered = await ticket.delivered;
  inFlight.current.delete(item.uid);
  if (delivered.status === "failed") {
    setHiddenUids((current) => {
      const next = new Set(current);
      next.delete(item.uid);
      return next;
    });
    setStatus(item.uid, { state: "error", message: String(delivered.error) });
    return;
  }
  setStatus(item.uid);
  onLinked?.();
};
```

Import `WriteTicket` from `../sync/opQueue`. Render only visible items and omit groups whose visible item list is empty. Derive the count as `Math.max(0, total - hiddenUids.size)` when `total !== null`; do not change `offset`. Inside the visible-item map, bind `const status = itemStatus[item.uid]` and render:

```tsx
<div className="backlink-item" key={item.uid}>
  <div className="unlinked-link-row">
    <div className="backlink-text">
      <InlineSegments segments={tokenizeBlock(item.text)} />
    </div>
    <button
      className="reference-link-button btn-secondary"
      disabled={!sync.canEdit || status?.state === "pending"}
      title={!sync.canEdit ? sync.readOnlyReason : undefined}
      onClick={() => void linkItem(g, item)}
    >
      {status?.state === "pending" ? "Linking…" : "Link"}
    </button>
  </div>
  {status?.state === "error" && (
    <p className="error unlinked-item-error">{status.message}</p>
  )}
</div>
```

- [ ] **Step 4: Run component tests and confirm GREEN**

```bash
cd web
pnpm exec vitest run src/components/sections.test.tsx
pnpm typecheck
```

Expected: all section tests pass; unrelated buttons remain usable while one write is pending.

- [ ] **Step 5: Commit and push Task 3**

```bash
git add web/src/components/UnlinkedSection.tsx web/src/components/sections.test.tsx
git commit -m "feat(web): link unlinked reference results"
git push
```

---

### Task 4: Refresh Linked References After Delivery

**Files:**
- Modify: `web/src/components/BacklinksSection.tsx`
- Modify: `web/src/components/sections.test.tsx`
- Modify: `web/src/views/PageView.tsx`
- Modify: `web/src/views/PageView.test.tsx`

**Interfaces:**
- Consumes: `UnlinkedSection.onLinked` from Task 3.
- Produces: `BacklinksSection({ title, initial, refreshGeneration? })` where a new generation replaces its reference snapshot.

- [ ] **Step 1: Add failing refresh tests for `BacklinksSection`**

Extend `web/src/components/sections.test.tsx` with tests using `rerender` and deferred fetch responses:

```ts
it("refresh generation replaces the first backlink batch", async () => {
  const refreshed = pagePayload("ACME", [], { backlinks: {
    groups: [{ page_id: 8, page_title: "Fresh Source", items: [
      { uid: "fresh", text: "[[ACME]] now linked", breadcrumbs: [] },
    ] }],
    total_pages: 1, offset: 0, limit: 20,
  } });
  stubFetch([["/api/page/ACME?bl_offset=0&bl_limit=20", refreshed]]);
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={initial} refreshGeneration={0} />
    </MemoryRouter>,
  );
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BacklinksSection title="ACME" initial={initial} refreshGeneration={1} />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("link", { name: "Fresh Source" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "July 7th, 2026" })).toBeNull();
});
```

Add separate tests with concrete payloads for:

- an open filter panel fetching offset `0`, limit `100`, then subsequent offsets until `groups.length >= total_pages`;
- preserving selected include/exclude chips and panel state after replacement;
- a failed refresh retaining old groups and showing `Retry refresh`, whose successful retry replaces them;
- generation 2 resolving before generation 1 and remaining visible after generation 1 later resolves.

- [ ] **Step 2: Run section tests and confirm RED**

```bash
cd web
pnpm exec vitest run src/components/sections.test.tsx
```

Expected: TypeScript/test compilation fails because `refreshGeneration` is not a prop.

- [ ] **Step 3: Refactor backlink reads and implement replacement refresh**

Change the signature in `web/src/components/BacklinksSection.tsx`:

```ts
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export function BacklinksSection({ title, initial, refreshGeneration = 0 }: {
  title: string;
  initial: Backlinks;
  refreshGeneration?: number;
}) {
```

Make the low-level read return data without mutating state:

```ts
const fetchBatch = useCallback((offset: number, limit: number) =>
  apiFetch<PagePayload>(
    `/api/page/${encodeTitle(title)}?bl_offset=${offset}&bl_limit=${limit}`,
  ), [title]);
```

Update `loadMore` and `loadAll` so the shell applies returned data explicitly and trusts the latest total:

```ts
const loadMore = async () => {
  setLoading(true);
  setError(null);
  try {
    const payload = await fetchBatch(groups.length, initial.limit);
    setGroups((current) => mergeGroups(current, payload.backlinks.groups));
    setTotalPages(payload.backlinks.total_pages);
    setExtraRefTexts((current) => ({
      ...current, ...payload.block_ref_texts,
    }));
  } catch (loadFailure: unknown) {
    setError(String(loadFailure));
  } finally {
    setLoading(false);
  }
};

const loadAll = async () => {
  setLoading(true);
  setError(null);
  try {
    let all = groups;
    let total = totalPages;
    let refTexts = { ...extraRefTexts };
    while (all.length < total) {
      const payload = await fetchBatch(all.length, 100);
      total = payload.backlinks.total_pages;
      refTexts = { ...refTexts, ...payload.block_ref_texts };
      if (payload.backlinks.groups.length === 0) break;
      const before = all.length;
      all = mergeGroups(all, payload.backlinks.groups);
      if (all.length === before) break;
    }
    setGroups(all);
    setTotalPages(total);
    setExtraRefTexts(refTexts);
  } catch (loadFailure: unknown) {
    setError(String(loadFailure));
  } finally {
    setLoading(false);
  }
};
```

Add separate refresh state. Gather the replacement inside the stable callback so the hooks linter needs no suppression:

```ts
const [refreshing, setRefreshing] = useState(false);
const [refreshError, setRefreshError] = useState<string | null>(null);
const refreshSeq = useRef(0);
const seenRefreshGeneration = useRef(refreshGeneration);

const refresh = useCallback(async () => {
  const seq = ++refreshSeq.current;
  setRefreshing(true);
  setRefreshError(null);
  try {
    let payload = await fetchBatch(0, panelOpen ? 100 : initial.limit);
    let nextGroups = payload.backlinks.groups;
    let nextTotal = payload.backlinks.total_pages;
    let nextRefTexts = { ...payload.block_ref_texts };
    while (panelOpen && nextGroups.length < nextTotal) {
      payload = await fetchBatch(nextGroups.length, 100);
      nextTotal = payload.backlinks.total_pages;
      nextRefTexts = { ...nextRefTexts, ...payload.block_ref_texts };
      if (payload.backlinks.groups.length === 0) break;
      const before = nextGroups.length;
      nextGroups = mergeGroups(nextGroups, payload.backlinks.groups);
      if (nextGroups.length === before) break;
    }
    if (seq !== refreshSeq.current) return;
    setGroups(nextGroups);
    setTotalPages(nextTotal);
    setExtraRefTexts(nextRefTexts);
  } catch (refreshFailure: unknown) {
    if (seq === refreshSeq.current) setRefreshError(String(refreshFailure));
  } finally {
    if (seq === refreshSeq.current) setRefreshing(false);
  }
}, [fetchBatch, initial.limit, panelOpen]);

useEffect(() => {
  if (refreshGeneration === seenRefreshGeneration.current) return;
  seenRefreshGeneration.current = refreshGeneration;
  void refresh();
}, [refreshGeneration, refresh]);
```

The `seenRefreshGeneration` guard is required: changing filter-panel state changes `refresh`, but must not consume the same generation twice.

Render refresh failure and retry independently of pagination errors:

```tsx
{refreshError && <p className="error">{refreshError}</p>}
{refreshError && (
  <button className="show-more btn-secondary"
          onClick={() => void refresh()} disabled={refreshing}>
    {refreshing ? "Refreshing…" : "Retry refresh"}
  </button>
)}
```

- [ ] **Step 4: Add the failing PageView coordination test**

In `web/src/views/PageView.test.tsx`, add this canonical-title coordination test:

```ts
it("links with the canonical payload title and refreshes backlinks", async () => {
  const sync = makeSync();
  const refreshed = pagePayload("ACME", [], { backlinks: {
    groups: [{ page_id: 9, page_title: "Source", items: [{
      uid: "uid_unlinked", text: "[[ACME]] mention", breadcrumbs: [],
    }] }],
    total_pages: 1, offset: 0, limit: 20,
  } });
  stubFetch([
    ["/api/page/ACME?bl_offset=0&bl_limit=20", refreshed],
    ["/api/unlinked?title=ACME", {
      groups: [{ page_id: 9, page_title: "Source", items: [
        { uid: "uid_unlinked", text: "Acme mention" },
      ] }],
      total: 1,
    }],
    ["/api/page/acme", pagePayload("ACME", [])],
  ]);

  render(
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/acme"]}>
        <Routes><Route path="/page/*" element={<PageView />} /></Routes>
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  expect(await screen.findByRole("heading", { name: "ACME" })).toBeInTheDocument();
  fireEvent.click(screen.getByText(/unlinked references/i));
  fireEvent.click(await screen.findByRole("button", { name: "Link" }));
  await vi.waitFor(() => expect(sync.sent).toHaveLength(1));
  expect(sync.sent[0][0]).toMatchObject({
    op: "update_text", uid: "uid_unlinked", text: "[[ACME]] mention",
  });
  expect(await screen.findByRole("link", { name: "Source" })).toBeInTheDocument();
});
```

- [ ] **Step 5: Run PageView test and confirm RED**

```bash
cd web
pnpm exec vitest run src/views/PageView.test.tsx
```

Expected: no Link action is wired through PageView, or the route spelling `acme` is used instead of canonical `ACME`.

- [ ] **Step 6: Wire canonical title and refresh generation in `PageView`**

Add state and a stable callback:

```ts
const [linkedRefreshGeneration, setLinkedRefreshGeneration] = useState(0);
const onLinked = useCallback(() => {
  setLinkedRefreshGeneration((generation) => generation + 1);
}, []);
```

Replace the reference-section render with:

```tsx
<BacklinksSection
  key={`bl-${title}`}
  title={payload.page.title}
  initial={payload.backlinks}
  refreshGeneration={linkedRefreshGeneration}
/>
<UnlinkedSection
  key={`ul-${title}`}
  title={payload.page.title}
  onLinked={onLinked}
/>
```

Keep route `title` for navigation/session ownership and use `payload.page.title` only where canonical reference casing is required.

- [ ] **Step 7: Run coordinated tests and confirm GREEN**

```bash
cd web
pnpm exec vitest run src/components/sections.test.tsx src/views/PageView.test.tsx
pnpm typecheck
pnpm lint
```

Expected: all tests pass, refresh replaces stale groups, active filter state survives, and stale refresh responses are ignored.

- [ ] **Step 8: Commit and push Task 4**

```bash
git add web/src/components/BacklinksSection.tsx web/src/components/sections.test.tsx \
  web/src/views/PageView.tsx web/src/views/PageView.test.tsx
git commit -m "feat(web): refresh backlinks after linking"
git push
```

---

### Task 5: Add Compact Styling and Browser Coverage

**Files:**
- Modify: `web/src/styles.css:439-493`
- Modify: `web/src/styles.test.ts`
- Create: `web/e2e/link-reference.spec.ts`

**Interfaces:**
- Consumes: `.unlinked-link-row`, `.reference-link-button`, and `.unlinked-item-error` from Task 3.
- Produces: responsive compact layout and full user-flow coverage.

- [ ] **Step 1: Add the failing static CSS test**

Add to `web/src/styles.test.ts`:

```ts
describe("unlinked reference Link action (pkm-965i)", () => {
  test("keeps text flexible and the compact action visible", () => {
    expect(ruleFor(".unlinked-link-row")).toContain("display: flex;");
    expect(ruleFor(".unlinked-link-row .backlink-text")).toContain("min-width: 0;");
    expect(ruleFor(".reference-link-button")).toContain("flex-shrink: 0;");
    expect(ruleFor(".reference-link-button")).toContain("font-size: 12px;");
  });
});
```

- [ ] **Step 2: Run the style test and confirm RED**

```bash
cd web
pnpm exec vitest run src/styles.test.ts
```

Expected: `ruleFor` reports missing `.unlinked-link-row`.

- [ ] **Step 3: Add focused layout styles**

Add under the backlinks/unlinked section in `web/src/styles.css`:

```css
.unlinked-link-row { display: flex; align-items: flex-start; gap: 8px; }
.unlinked-link-row .backlink-text { flex: 1; min-width: 0; }
.reference-link-button { flex-shrink: 0; font-size: 12px; padding: 1px 8px; }
.unlinked-item-error { margin: 4px 0 0; }
```

Do not duplicate colors, borders, hover rules, or radius rules from `.btn-secondary`.

- [ ] **Step 4: Run the style test and confirm GREEN**

```bash
cd web
pnpm exec vitest run src/styles.test.ts
```

Expected: all style tests pass.

- [ ] **Step 5: Write the failing Playwright scenarios**

Create `web/e2e/link-reference.spec.ts`. Follow `e2e/backlink-filter.spec.ts` for login, unique page names, editor writes, and server polling. Include two tests:

```ts
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "e2e-pw";
const input = (page: Page) => page.locator("textarea.block-input");

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

async function createPage(page: Page, title: string) {
  const response = await page.request.post("/api/pages", { data: { title } });
  expect(response.ok()).toBeTruthy();
}

async function waitForText(page: Page, pageTitle: string, text: string) {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/page/${encodeURIComponent(pageTitle)}`);
    if (!response.ok()) return false;
    const payload = await response.json() as { blocks: { text: string }[] };
    return payload.blocks.some((block) => block.text === text);
  }, { timeout: 20_000 }).toBe(true);
}

test("links a differently cased plain mention with canonical casing (pkm-965i)", async ({ page }) => {
  const stamp = Date.now();
  const target = `LinkTarget${stamp}`;
  const source = `LinkSource${stamp}`;
  const original = `${target.toLowerCase()} created the jumbotron`;
  const linked = `[[${target}]] created the jumbotron`;
  await login(page);
  await createPage(page, target);
  await createPage(page, source);
  await page.goto(`/page/${encodeURIComponent(source)}`);
  await page.getByText("Click to start writing…").click();
  await input(page).fill(original);
  await input(page).press("Escape");
  await waitForText(page, source, original);

  await page.goto(`/page/${encodeURIComponent(target)}`);
  await page.locator(".unlinked .section-header").click();
  const group = page.locator(".unlinked .backlink-group", { hasText: source });
  await group.getByRole("button", { name: "Link" }).click();
  await waitForText(page, source, linked);
  await expect(group).toHaveCount(0);
  await expect(page.locator(".backlinks .backlink-group", { hasText: source })).toBeVisible();
});

test("preserves Markdown and appends a canonical tag (pkm-965i)", async ({ page }) => {
  const stamp = Date.now();
  const target = `MarkdownTarget${stamp}`;
  const source = `MarkdownSource${stamp}`;
  const href = `https://example.test/${target.toLowerCase()}/study.md`;
  const original = `[A study](${href}) shows great things`;
  const linked = `${original} #[[${target}]]`;
  await login(page);
  await createPage(page, target);
  await createPage(page, source);
  await page.goto(`/page/${encodeURIComponent(source)}`);
  await page.getByText("Click to start writing…").click();
  await input(page).fill(original);
  await input(page).press("Escape");
  await waitForText(page, source, original);

  await page.goto(`/page/${encodeURIComponent(target)}`);
  await page.locator(".unlinked .section-header").click();
  const group = page.locator(".unlinked .backlink-group", { hasText: source });
  await group.getByRole("button", { name: "Link" }).click();
  await waitForText(page, source, linked);
  const backlink = page.locator(".backlinks .backlink-group", { hasText: source });
  await expect(backlink.locator(`a[href="${href}"]`)).toHaveText("A study");
  await expect(backlink.getByRole("link", { name: target })).toBeVisible();
});
```

- [ ] **Step 6: Run the focused browser test and fix only observed integration gaps**

```bash
cd web
pnpm e2e -- e2e/link-reference.spec.ts
```

Expected before the complete UI wiring: the Link locator is absent. After Tasks 1-4 and the CSS change: both scenarios pass. If an assertion exposes timing, poll server text as above rather than adding fixed sleeps.

- [ ] **Step 7: Commit and push Task 5**

```bash
git add web/src/styles.css web/src/styles.test.ts web/e2e/link-reference.spec.ts
git commit -m "test(web): cover unlinked reference linking"
git push
```

---

### Task 6: Verify, Review, and Complete the Bean

**Files:**
- Modify: `.beans/pkm-965i--link-button.md`

**Interfaces:**
- Consumes: all implementation tasks.
- Produces: verified branch, completed bean summary, and pushed commits.

- [ ] **Step 1: Run focused web checks once more**

```bash
cd web
pnpm exec vitest run src/grammar/linkReference.test.ts src/grammar/tokenize.test.ts \
  src/replica/queue.test.ts src/components/sections.test.tsx \
  src/views/PageView.test.tsx src/styles.test.ts
pnpm e2e -- e2e/link-reference.spec.ts
```

Expected: all focused unit and E2E tests pass.

- [ ] **Step 2: Run full required verification**

Run these commands from the worktree:

```bash
cd server && uv run pytest -q
cd server && uv run pyrefly check
cd server && uv run ruff check
cd web && pnpm verify
```

Expected:

- server: all tests pass with enforced coverage;
- pyrefly: 0 errors;
- ruff: all checks pass;
- web: typecheck, lint, FCIS, coverage, build, and all Playwright tests pass.

- [ ] **Step 3: Request code review and address findings**

Invoke `superpowers:requesting-code-review`. Give the reviewer the approved spec, this plan, and the full branch diff from `9f48575`. For each valid finding, add a failing regression test before changing behavior, rerun the affected focused suite, and commit/push the correction.

- [ ] **Step 4: Re-run verification after review changes**

Invoke `superpowers:verification-before-completion`, then repeat all four required commands from Step 2. Do not rely on results obtained before review fixes.

- [ ] **Step 5: Complete bean tracking**

Update `.beans/pkm-965i--link-button.md`:

- check `Write implementation plan` and `Implement with tests`;
- check `Verify, review, commit, and push` only after the final push succeeds;
- append a `## Summary of Changes` describing the transformation core, stale-write protection, Link UI, backlink refresh, and tests;
- set status to `completed` only when no unchecked checklist items remain.

Use `beans update` exact replacements and include the bean file in the final commit.

- [ ] **Step 6: Commit final tracking, push, and inspect branch state**

```bash
git add .beans/pkm-965i--link-button.md
git commit -m "chore: complete pkm-965i"
git push
git status --short
git log --oneline --decorate -8
```

Expected: clean working tree, all commits visible on `origin/feature/pkm-965i-link-button`, and bean `pkm-965i` completed with no unchecked items.
