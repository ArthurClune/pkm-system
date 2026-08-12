# pkm-vcn6: File Browser Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/files` cards interactive — refs badge opens a popover of referencing blocks (links), status badge opens the description/error, image thumbnails expand in-app, and the search box says it searches descriptions.

**Architecture:** Web-only; no server/API/schema changes. The refs popover reuses the existing `GET /api/block-refs?uids=…` batch endpoint and the `BacklinkGroupList` renderer; popover chrome copies `BlockRefBacklinksPopover` conventions (`clampPopoverPosition`, Escape/outside-mousedown dismissal, mouse/touch-only per pkm-3w2h). The fullscreen overlay is extracted from `AssetImage` into a shared `ImageOverlay`.

**Tech Stack:** React + TypeScript (web/), vitest + testing-library for unit tests, Playwright for e2e. Spec: `docs/superpowers/specs/2026-08-12-pkm-vcn6-file-browser-improvements-design.md` (read it from the main checkout at `/Users/arthur/code/llm/pkm/…` — worktrees branch from origin/main and may predate it).

## Global Constraints

- Work in a git worktree on a feature branch (CLAUDE.md); merge later with `--no-ff`. **Before every commit run `git status -sb`** to confirm you are on the worktree branch, not main.
- Every runtime file keeps/declares its `// pattern: Functional Core` or `// pattern: Imperative Shell` header. Pure helpers go in `filesCore.ts` (Core); components are Shell.
- TDD: write the failing test, see it fail, implement, see it pass, commit. Bean file `.beans/pkm-vcn6*` gets its checklist updated and committed with code changes.
- Verification before completion: `cd web && pnpm verify` (typecheck + unit coverage + e2e). No server changes → server test suite is unaffected (do not skip `pnpm verify`).
- Unit test runner: `cd web && pnpm test:unit <file>` runs one file (vitest). Type check alone: `pnpm typecheck`.
- Popovers are mouse/touch-only by accepted convention (pkm-3w2h) — do NOT add focus traps or keyboard focus management to them. (The image overlay's existing Tab/Escape handling is the exception and must be preserved exactly.)
- Copy is lowercase-ish and terse, matching existing labels ("Copy link", "orphan"). New user-visible strings defined in tasks below are exact — don't improvise.

---

### Task 0: Worktree + bean bookkeeping

**Files:**
- Modify: `.beans/` bean file for pkm-vcn6 (filename starts with `pkm-vcn6`)

- [ ] **Step 1: Create the worktree** — invoke the `superpowers:using-git-worktrees` skill (EnterWorktree, name `file-browser-improvements-vcn6`). NOTE: the worktree branches from origin/main; the spec and this plan live in the main checkout — read them by absolute path.
- [ ] **Step 2: Mark the bean in-progress with a checklist**

Run: `beans update pkm-vcn6 -s in-progress` **from the worktree root** (the bean file must be the worktree's copy). Then edit the bean file to add:

```markdown
## Checklist

- [ ] ImageOverlay extracted from AssetImage
- [ ] Image thumbnails expand in-app
- [ ] filesCore ref-grouping/chunking helpers
- [ ] FileCardPopovers (refs + description)
- [ ] Badges wired to popovers in Files.tsx
- [ ] Search placeholder mentions descriptions
- [ ] E2E coverage
- [ ] Docs updated (frontend.md)
```

- [ ] **Step 3: Commit** — `git add .beans && git commit -m "pkm-vcn6: start file browser improvements"`

---

### Task 1: Extract `ImageOverlay` from `AssetImage`

**Files:**
- Create: `web/src/components/ImageOverlay.tsx`
- Modify: `web/src/components/AssetImage.tsx`
- Test: existing `web/src/components/AssetImage.test.tsx` (unchanged — it is the safety net)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ImageOverlay({ src, alt, onClose, onError, triggerRef }: { src: string; alt: string; onClose: () => void; onError: () => void; triggerRef?: React.RefObject<HTMLButtonElement | null> })` — a portal fullscreen overlay. `onError` fires when the overlay image fails to load (caller closes + marks broken). Focus returns to `triggerRef.current` on unmount if still connected.

This is a behaviour-preserving refactor: no new tests; `AssetImage.test.tsx` must pass before and after, unmodified.

- [ ] **Step 1: Confirm the safety net is green**

Run: `cd web && pnpm test:unit src/components/AssetImage.test.tsx`
Expected: PASS

- [ ] **Step 2: Create `web/src/components/ImageOverlay.tsx`**

```tsx
// pattern: Imperative Shell
// Fullscreen overlay for uploaded images, extracted from AssetImage
// (pkm-vcn6) so the /files browser can share it. Owns the body scroll
// lock, Escape-to-close, Tab pinned to the Close button, and focus
// restore to the trigger on unmount.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export function ImageOverlay({ src, alt, onClose, onError, triggerRef }: {
  src: string;
  alt: string;
  onClose: () => void;
  /** The overlay image failed to load; caller closes and marks broken. */
  onError: () => void;
  /** Focus returns here when the overlay unmounts. */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const trigger = triggerRef?.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [onClose, triggerRef]);

  const dialogLabel = alt ? `Expanded image: ${alt}` : "Expanded image";
  return createPortal(
    <div
      className="image-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="image-overlay-bar">
        <button
          type="button"
          className="btn-secondary"
          ref={closeRef}
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div
        className="image-overlay-stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <img
          className="image-overlay-image"
          src={src}
          alt={alt}
          onError={onError}
        />
      </div>
    </div>,
    document.body,
  );
}
```

The mount effect depends on `onClose`, so callers MUST pass a stable callback (`useCallback`) or the scroll lock and close-button focus re-run every render.

- [ ] **Step 3: Slim `AssetImage.tsx` to delegate**

Replace the expansion effect (the `useEffect` guarded by `expanded`) and the `createPortal(...)` block with the shared component. The resulting `AssetImage`:

```tsx
// pattern: Imperative Shell
// Uploaded-asset image. Viewed assets are runtime-cached by the service
// worker (spec section 5); one that was never viewed can't load offline,
// so a failed load renders a labelled placeholder instead of a broken img.
// Uploaded /assets/ images also expand fullscreen via the shared
// ImageOverlay (pkm-vcn6).
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageOverlay } from "./ImageOverlay";

function isUploadedAsset(src: string): boolean {
  return src.startsWith("/assets/");
}

export function AssetImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A new src deserves a fresh attempt and must not leave the old image open.
  useEffect(() => {
    setFailed(false);
    setExpanded(false);
  }, [src]);

  const close = useCallback(() => setExpanded(false), []);
  const onError = useCallback(() => {
    setExpanded(false);
    setFailed(true);
  }, []);

  if (failed) {
    return (
      <span className="asset-image-placeholder" role="note">
        image unavailable offline{alt ? `: ${alt}` : ""}
      </span>
    );
  }

  const inlineImage = (
    <img className="asset-image" src={src} alt={alt} loading="lazy" onError={onError} />
  );
  if (!isUploadedAsset(src)) return inlineImage;

  const triggerLabel = alt ? `Expand image: ${alt}` : "Expand image";

  return (
    <>
      <button
        type="button"
        className="asset-image-trigger"
        aria-label={triggerLabel}
        ref={triggerRef}
        onClick={(event) => {
          event.stopPropagation();
          setExpanded(true);
        }}
      >
        {inlineImage}
      </button>
      {expanded && (
        <ImageOverlay src={src} alt={alt} onClose={close} onError={onError}
                      triggerRef={triggerRef} />
      )}
    </>
  );
}
```

(Behaviour notes preserved from the original: inline `onError` also closes any open overlay; `closeRef` moved into `ImageOverlay`.)

- [ ] **Step 4: Run the safety net + typecheck**

Run: `cd web && pnpm test:unit src/components/AssetImage.test.tsx && pnpm typecheck`
Expected: PASS, no type errors, `AssetImage.test.tsx` untouched (`git status` must not show it).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ImageOverlay.tsx web/src/components/AssetImage.tsx
git commit -m "pkm-vcn6: extract ImageOverlay from AssetImage"
```

---

### Task 2: Image thumbnails expand in-app in `FileCard`

**Files:**
- Modify: `web/src/views/Files.tsx` (the `FileCard` component, top of file)
- Modify: `web/src/styles.css` (near the `.file-thumb` rules, ~line 1007)
- Test: `web/src/views/Files.test.tsx`

**Interfaces:**
- Consumes: `ImageOverlay` from Task 1 (exact props above).
- Produces: image thumbs are `button.file-thumb` with `aria-label` `` `Expand image: ${item.filename}` ``; non-image and broken thumbs remain `a.file-thumb` (new tab).

- [ ] **Step 1: Write the failing tests** (append to `describe("Files", ...)` in `Files.test.tsx`):

```tsx
  it("expands an image thumbnail in-app instead of opening a tab", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    render(<Files />);
    const thumb = await screen.findByRole("button",
                                          { name: "Expand image: pic.png" });
    expect(thumb.closest("a")).toBeNull();
    fireEvent.click(thumb);
    const overlay = screen.getByRole("dialog",
                                     { name: "Expanded image: pic.png" });
    expect(overlay).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog",
                              { name: "Expanded image: pic.png" }))
      .not.toBeInTheDocument();
  });

  it("keeps the new-tab link for non-image files", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({
      sha256: "cd".repeat(32), filename: "notes.pdf",
      mime: "application/pdf",
    })]));
    render(<Files />);
    await screen.findByText("notes.pdf");
    const label = screen.getByText("pdf");
    const link = label.closest("a");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("button", { name: /Expand image/ }))
      .not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test:unit src/views/Files.test.tsx`
Expected: the two new tests FAIL (no button named "Expand image: pic.png"); the rest PASS.

- [ ] **Step 3: Implement in `FileCard`**

Add imports at the top of `Files.tsx`: `useCallback` is already imported; add `import { ImageOverlay } from "../components/ImageOverlay";`.

Replace `FileCard`'s thumbnail block (currently the `<a className="file-thumb" …>` wrapping the img-or-label ternary) with:

```tsx
  const [expanded, setExpanded] = useState(false);
  const thumbRef = useRef<HTMLButtonElement>(null);
  const closeOverlay = useCallback(() => setExpanded(false), []);
  const overlayError = useCallback(() => {
    setExpanded(false);
    setBroken(true);
  }, []);
```

(state lines go beside the existing `broken` state; `useRef` is already imported in Files.tsx)

```tsx
      {category === "image" && !broken ? (
        <button type="button" className="file-thumb" ref={thumbRef}
                aria-label={`Expand image: ${item.filename}`}
                onClick={() => setExpanded(true)}>
          <img src={item.url} alt={item.filename} loading="lazy"
               onError={() => setBroken(true)} />
        </button>
      ) : (
        <a className="file-thumb" href={item.url} target="_blank"
           rel="noreferrer">
          <span className="file-type-label">{category}</span>
        </a>
      )}
      {expanded && (
        <ImageOverlay src={item.url} alt={item.filename}
                      onClose={closeOverlay} onError={overlayError}
                      triggerRef={thumbRef} />
      )}
```

Note the broken-image case now shows the type label inside the link, same as before (`category === "image" && broken` → label reads "image").

- [ ] **Step 4: Add CSS** (in `web/src/styles.css`, directly after the `.file-thumb img` rule ~line 1012):

```css
/* pkm-vcn6: an image thumb is a button (in-app expansion), not a link */
button.file-thumb { appearance: none; width: 100%; padding: 0;
  border: none; font: inherit; cursor: zoom-in; }
button.file-thumb:focus-visible { outline: 2px solid var(--color-link);
  outline-offset: 2px; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && pnpm test:unit src/views/Files.test.tsx && pnpm typecheck`
Expected: PASS (including the pre-existing broken-image fallback test).

- [ ] **Step 6: Commit** (tick the two done checklist items in the bean file first)

```bash
git add web/src/views/Files.tsx web/src/styles.css web/src/views/Files.test.tsx .beans
git commit -m "pkm-vcn6: expand file-browser image thumbs in-app"
```

---

### Task 3: `filesCore` helpers — chunking and ref grouping

**Files:**
- Modify: `web/src/views/filesCore.ts`
- Test: `web/src/views/filesCore.test.ts`

**Interfaces:**
- Consumes: `BacklinkGroup` type from `../api/payloads` (shape: `{ page_id: number; page_title: string; items: { uid: string; text: string; breadcrumbs: string[] }[] }`).
- Produces (exact exports Task 4 imports):
  - `interface AssetRef { uid: string; page_title: string }`
  - `const MISSING_BLOCK_TEXT = "(block not found)"`
  - `refUidChunks(refs: readonly AssetRef[]): string[][]` — uid lists of ≤50 (the `/api/block-refs` cap)
  - `refGroups(refs: readonly AssetRef[], texts: Record<string, { text: string; page_title: string }>): BacklinkGroup[]`

- [ ] **Step 1: Write the failing tests** (append to `filesCore.test.ts`):

```ts
describe("refUidChunks", () => {
  it("chunks ref uids at the block-refs cap of 50", () => {
    const refs = Array.from({ length: 101 }, (_, i) =>
      ({ uid: `u${i}`, page_title: "P" }));
    const chunks = refUidChunks(refs);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 1]);
    expect(chunks[0][0]).toBe("u0");
    expect(chunks[2][0]).toBe("u100");
  });

  it("returns no chunks for no refs", () => {
    expect(refUidChunks([])).toEqual([]);
  });
});

describe("refGroups", () => {
  it("groups refs by page in first-seen order with fetched text", () => {
    const refs = [
      { uid: "a1", page_title: "Alpha" },
      { uid: "b1", page_title: "Beta" },
      { uid: "a2", page_title: "Alpha" },
    ];
    const texts = {
      a1: { text: "first", page_title: "Alpha" },
      b1: { text: "second", page_title: "Beta" },
      a2: { text: "third", page_title: "Alpha" },
    };
    expect(refGroups(refs, texts)).toEqual([
      { page_id: 0, page_title: "Alpha", items: [
        { uid: "a1", text: "first", breadcrumbs: [] },
        { uid: "a2", text: "third", breadcrumbs: [] },
      ] },
      { page_id: 1, page_title: "Beta", items: [
        { uid: "b1", text: "second", breadcrumbs: [] },
      ] },
    ]);
  });

  it("falls back to a placeholder for uids the endpoint omitted", () => {
    const groups = refGroups([{ uid: "gone", page_title: "P" }], {});
    expect(groups[0].items[0].text).toBe(MISSING_BLOCK_TEXT);
  });
});
```

Add `MISSING_BLOCK_TEXT, refGroups, refUidChunks` to the file's import from `./filesCore`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test:unit src/views/filesCore.test.ts`
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Implement** (append to `filesCore.ts`; add `BacklinkGroup` to its type import from `../api/payloads`):

```ts
export interface AssetRef {
  uid: string;
  page_title: string;
}

// GET /api/block-refs rejects more than 50 uids per call.
const BLOCK_REFS_CAP = 50;

export function refUidChunks(refs: readonly AssetRef[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < refs.length; i += BLOCK_REFS_CAP) {
    chunks.push(refs.slice(i, i + BLOCK_REFS_CAP).map((r) => r.uid));
  }
  return chunks;
}

export const MISSING_BLOCK_TEXT = "(block not found)";

// Shape an asset's refs for BacklinkGroupList. page_id is a synthetic
// key (the search payload carries no page ids) and breadcrumbs aren't
// available here, so rows carry text only.
export function refGroups(
  refs: readonly AssetRef[],
  texts: Record<string, { text: string; page_title: string }>,
): BacklinkGroup[] {
  const groups: BacklinkGroup[] = [];
  const byTitle = new Map<string, BacklinkGroup>();
  for (const ref of refs) {
    let group = byTitle.get(ref.page_title);
    if (group === undefined) {
      group = { page_id: groups.length, page_title: ref.page_title,
                items: [] };
      byTitle.set(ref.page_title, group);
      groups.push(group);
    }
    group.items.push({
      uid: ref.uid,
      text: texts[ref.uid]?.text ?? MISSING_BLOCK_TEXT,
      breadcrumbs: [],
    });
  }
  return groups;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm test:unit src/views/filesCore.test.ts && pnpm typecheck`
Expected: PASS. (If `BacklinkGroup` has extra required fields the test literals lack, fix the test literals to match the generated type — do not cast.)

- [ ] **Step 5: Commit**

```bash
git add web/src/views/filesCore.ts web/src/views/filesCore.test.ts .beans
git commit -m "pkm-vcn6: ref grouping and uid chunking for file cards"
```

---

### Task 4: `FileCardPopovers` — refs popover + description popover

**Files:**
- Create: `web/src/views/FileCardPopovers.tsx`
- Test: `web/src/views/FileCardPopovers.test.tsx` (new; mirrors `web/src/components/BlockRefBacklinksPopover.test.tsx` patterns)

**Interfaces:**
- Consumes: Task 3 exports; `BacklinkGroupList` (`components/BacklinkGroupList.tsx`, props `{ groups, onNavigate?(pageTitle, uid) }`); `clampPopoverPosition` (`../popoverPosition`); `pagePath` (`../paths`); `apiGet` (`../api/typedClient`).
- Produces:
  - `FileRefsPopover({ refs, x, y, onClose }: { refs: readonly AssetRef[]; x: number; y: number; onClose: () => void })` — dialog labelled `"References"`.
  - `FileDescriptionPopover({ label, text, x, y, onClose }: { label: string; text: string; x: number; y: number; onClose: () => void })` — dialog labelled by `label`.

- [ ] **Step 1: Write the failing tests** — create `web/src/views/FileCardPopovers.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { apiGet } from "../api/typedClient";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { MISSING_BLOCK_TEXT } from "./filesCore";
import { FileDescriptionPopover, FileRefsPopover } from "./FileCardPopovers";

vi.mock("../api/typedClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/typedClient")>();
  return { ...actual, apiGet: vi.fn() };
});
const mockApiGet = vi.mocked(apiGet);

// Same location-probe pattern as BlockRefBacklinksPopover.test.tsx.
function Probe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.pathname + loc.hash}</p>;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/files"]}>
      {children}
      <Probe />
    </MemoryRouter>
  );
}

afterEach(() => {
  mockApiGet.mockReset();
  vi.restoreAllMocks();
});

const REFS = [
  { uid: "a1", page_title: "Alpha" },
  { uid: "b1", page_title: "Beta" },
];

it("fetches block text and renders refs grouped by page", async () => {
  mockApiGet.mockResolvedValueOnce({ block_ref_texts: {
    a1: { text: "alpha mentions it", page_title: "Alpha" },
    b1: { text: "beta mentions it", page_title: "Beta" },
  } });
  render(<FileRefsPopover refs={REFS} x={10} y={20} onClose={vi.fn()} />,
         { wrapper });
  expect(await screen.findByText("alpha mentions it")).toBeInTheDocument();
  expect(screen.getByText("Alpha")).toBeInTheDocument();
  expect(screen.getByText("beta mentions it")).toBeInTheDocument();
  expect(mockApiGet).toHaveBeenCalledWith(
    "/api/block-refs", { query: { uids: "a1,b1" } });
});

it("navigates to the referencing block on click, and closes", async () => {
  mockApiGet.mockResolvedValueOnce({ block_ref_texts: {
    a1: { text: "alpha mentions it", page_title: "Alpha" },
    b1: { text: "beta mentions it", page_title: "Beta" },
  } });
  const onClose = vi.fn();
  render(<FileRefsPopover refs={REFS} x={0} y={0} onClose={onClose} />,
         { wrapper });
  fireEvent.click(await screen.findByRole("link",
                                          { name: "alpha mentions it" }));
  expect(onClose).toHaveBeenCalled();
  expect(screen.getByTestId("loc")).toHaveTextContent("/page/Alpha#a1");
});

it("renders a placeholder row for a uid the endpoint omitted", async () => {
  mockApiGet.mockResolvedValueOnce({ block_ref_texts: {
    a1: { text: "alpha mentions it", page_title: "Alpha" },
  } });
  render(<FileRefsPopover refs={REFS} x={0} y={0} onClose={vi.fn()} />,
         { wrapper });
  expect(await screen.findByText(MISSING_BLOCK_TEXT)).toBeInTheDocument();
});

it("falls back to page-title-only rows when the fetch fails", async () => {
  mockApiGet.mockRejectedValueOnce(new Error("boom"));
  render(<FileRefsPopover refs={REFS} x={0} y={0} onClose={vi.fn()} />,
         { wrapper });
  expect(await screen.findByText(/could not load block text/i))
    .toBeInTheDocument();
  expect(screen.getByText("Alpha")).toBeInTheDocument();
  expect(screen.getAllByText(MISSING_BLOCK_TEXT)).toHaveLength(2);
});

it("Escape and outside mousedown close the refs popover", async () => {
  mockApiGet.mockResolvedValue({ block_ref_texts: {} });
  const onClose = vi.fn();
  render(<FileRefsPopover refs={REFS} x={0} y={0} onClose={onClose} />,
         { wrapper });
  await screen.findAllByText(MISSING_BLOCK_TEXT);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.mouseDown(document.body);
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("shows the description without any fetch", () => {
  render(<FileDescriptionPopover label="Description"
                                 text="a bar chart of monthly revenue"
                                 x={5} y={5} onClose={vi.fn()} />,
         { wrapper });
  expect(screen.getByRole("dialog", { name: "Description" }))
    .toHaveTextContent("a bar chart of monthly revenue");
  expect(mockApiGet).not.toHaveBeenCalled();
});

it("clamps into the viewport like the block-ref popover", async () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 480, height: 300, x: 0, y: 0, top: 0, left: 0,
    right: 480, bottom: 300, toJSON: () => ({}),
  } as DOMRect);
  render(<FileDescriptionPopover label="Description" text="wide"
                                 x={2000} y={1500} onClose={vi.fn()} />,
         { wrapper });
  const popover = screen.getByRole("dialog", { name: "Description" });
  expect(popover.style.left).toBe(`${1024 - 480 - 12}px`);
  expect(popover.style.top).toBe(`${768 - 300 - 12}px`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test:unit src/views/FileCardPopovers.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create `web/src/views/FileCardPopovers.tsx`**

```tsx
// pattern: Imperative Shell
// Popovers for /files cards (pkm-vcn6): which blocks reference an asset,
// and its description / describe error. Chrome, clamping, and dismissal
// follow BlockRefBacklinksPopover; mouse/touch-only by the accepted
// popover convention (pkm-3w2h).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../api/typedClient";
import type { BacklinkGroup } from "../api/payloads";
import { BacklinkGroupList } from "../components/BacklinkGroupList";
import { pagePath } from "../paths";
import { clampPopoverPosition } from "../popoverPosition";
import { refGroups, refUidChunks } from "./filesCore";
import type { AssetRef } from "./filesCore";

function CardPopover({ label, x, y, onClose, remeasure, children }: {
  label: string;
  x: number;
  y: number;
  onClose: () => void;
  /** Values whose change resizes the content (loading -> rows), so the
   * clamp re-runs; same trick as BlockRefBacklinksPopover. */
  remeasure: readonly unknown[];
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clampPopoverPosition({
      x, y, width: rect.width, height: rect.height,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      margin: 12,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, ...remeasure]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="block-ref-popover" role="dialog" aria-label={label}
         ref={ref} style={{ left: pos.x, top: pos.y }}>
      {children}
    </div>
  );
}

export function FileRefsPopover({ refs, x, y, onClose }: {
  refs: readonly AssetRef[]; x: number; y: number; onClose: () => void;
}) {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<BacklinkGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGroups(null);
    setError(null);
    Promise.all(refUidChunks(refs).map((uids) =>
      apiGet("/api/block-refs", { query: { uids: uids.join(",") } })))
      .then((payloads) => {
        if (cancelled) return;
        const texts = Object.assign(
          {}, ...payloads.map((p) => p.block_ref_texts));
        setGroups(refGroups(refs, texts));
      })
      .catch((fetchFailure: unknown) => {
        // Text is decoration; the refs themselves came with the search
        // payload, so degrade to placeholder rows instead of nothing.
        if (cancelled) return;
        setError(String(fetchFailure));
        setGroups(refGroups(refs, {}));
      });
    return () => { cancelled = true; };
  }, [refs]);

  return (
    <CardPopover label="References" x={x} y={y} onClose={onClose}
                 remeasure={[groups, error]}>
      {error !== null && (
        <p className="error">Could not load block text: {error}</p>
      )}
      {groups === null && error === null && (
        <p className="loading">Loading…</p>
      )}
      {groups !== null && (
        <BacklinkGroupList groups={groups}
          onNavigate={(pageTitle, uid) => {
            onClose();
            navigate(`${pagePath(pageTitle)}#${uid}`);
          }} />
      )}
    </CardPopover>
  );
}

export function FileDescriptionPopover({ label, text, x, y, onClose }: {
  label: string; text: string; x: number; y: number; onClose: () => void;
}) {
  return (
    <CardPopover label={label} x={x} y={y} onClose={onClose}
                 remeasure={[text]}>
      <p className="file-popover-text">{text}</p>
    </CardPopover>
  );
}
```

- [ ] **Step 4: Add CSS** (in `web/src/styles.css`, after the `.file-badge` rules ~line 1031):

```css
/* pkm-vcn6: description/error text inside a card popover */
.file-popover-text { margin: 4px 0; font-size: 0.9em;
  white-space: pre-wrap; overflow-wrap: anywhere; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && pnpm test:unit src/views/FileCardPopovers.test.tsx && pnpm typecheck`
Expected: PASS. If `apiGet`'s generated types reject `"/api/block-refs"` with a `query` object, check how `openapi.json` names the param (it is `uids`, a required string) and match the call shape — do not cast to `any`.

- [ ] **Step 6: Commit**

```bash
git add web/src/views/FileCardPopovers.tsx web/src/views/FileCardPopovers.test.tsx web/src/styles.css .beans
git commit -m "pkm-vcn6: refs and description popovers for file cards"
```

---

### Task 5: Wire the badges in `Files.tsx`

**Files:**
- Modify: `web/src/views/Files.tsx` (`FileCard`)
- Modify: `web/src/styles.css` (`.file-badge` rules ~line 1023)
- Test: `web/src/views/Files.test.tsx`

**Interfaces:**
- Consumes: `FileRefsPopover` / `FileDescriptionPopover` from Task 4 (exact props above).
- Produces: the linked badge and the described/failed status badges are `button.file-badge`; `orphan` and `pending` remain spans.

- [ ] **Step 1: Add a router wrapper to `Files.test.tsx`.** `FileRefsPopover` uses `useNavigate`/`PageLink`, so `<Files />` now needs router context. At the top of the file add:

```tsx
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
```

and a helper next to `payload(...)`:

```tsx
const renderFiles = () =>
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/files"]}>
      <Files />
    </MemoryRouter>,
  );
```

Mechanically replace every `render(<Files />);` with `renderFiles();` (the `render` import stays — the helper uses it).

- [ ] **Step 2: Write the failing tests** (append to the describe block):

```tsx
  it("opens the refs popover from the refs badge", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/block-refs")) {
        return Promise.resolve({ block_ref_texts: {
          b1: { text: "embeds the pic", page_title: "AI" } } });
      }
      return Promise.resolve(payload([item({
        refs: [{ uid: "b1", page_title: "AI" }] })]));
    });
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "1 ref" }));
    const popover = await screen.findByRole("dialog",
                                            { name: "References" });
    expect(popover).toHaveClass("block-ref-popover");
    expect(await screen.findByText("embeds the pic")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "References" }))
      .not.toBeInTheDocument();
  });

  it("keeps the orphan badge inert", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    renderFiles();
    const badge = await screen.findByText("orphan");
    expect(badge.tagName).toBe("SPAN");
  });

  it("shows the description from the described badge", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({
      description: "a bar chart of monthly revenue" })]));
    renderFiles();
    fireEvent.click(await screen.findByRole("button",
                                            { name: "described" }));
    expect(screen.getByRole("dialog", { name: "Description" }))
      .toHaveTextContent("a bar chart of monthly revenue");
  });

  it("shows the error from the failed badge", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({
      status: "failed", describe_error: "too large" })]));
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "failed" }));
    expect(screen.getByRole("dialog", { name: "Description error" }))
      .toHaveTextContent("too large");
  });

  it("keeps the pending badge inert", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({ status: "pending" })]));
    renderFiles();
    const badge = await screen.findByText("pending");
    expect(badge.tagName).toBe("SPAN");
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && pnpm test:unit src/views/Files.test.tsx`
Expected: the five new tests FAIL (badges are spans); every pre-existing test PASSES via `renderFiles()`.

- [ ] **Step 4: Implement in `FileCard`**

Import at the top of `Files.tsx`:

```tsx
import {
  FileDescriptionPopover, FileRefsPopover,
} from "./FileCardPopovers";
```

Inside `FileCard`, next to the existing state:

```tsx
  const [popover, setPopover] = useState<
    { kind: "refs" | "status"; x: number; y: number } | null>(null);
```

Replace the `file-badges` span block with:

```tsx
      <span className="file-badges">
        {item.status === "pending" ? (
          <span className="file-badge status-pending">pending</span>
        ) : (
          <button type="button"
                  className={`file-badge status-${item.status}`}
                  title={item.describe_error ?? undefined}
                  onClick={(e) => setPopover(
                    { kind: "status", x: e.clientX, y: e.clientY })}>
            {item.status}
          </button>
        )}
        {item.refs.length ? (
          <button type="button" className="file-badge linked"
                  onClick={(e) => setPopover(
                    { kind: "refs", x: e.clientX, y: e.clientY })}>
            {`${item.refs.length} ref${item.refs.length === 1 ? "" : "s"}`}
          </button>
        ) : (
          <span className="file-badge orphan">orphan</span>
        )}
      </span>
```

And after the `{expanded && (<ImageOverlay …/>)}` block:

```tsx
      {popover?.kind === "refs" && (
        <FileRefsPopover refs={item.refs} x={popover.x} y={popover.y}
                         onClose={() => setPopover(null)} />
      )}
      {popover?.kind === "status" && (
        <FileDescriptionPopover
          label={item.status === "failed"
            ? "Description error" : "Description"}
          text={(item.status === "failed"
            ? item.describe_error : item.description) ?? ""}
          x={popover.x} y={popover.y}
          onClose={() => setPopover(null)} />
      )}
```

(`status === "described"` implies a non-null description server-side — `derive_status` — so the `?? ""` is a type guard, not a real state.)

- [ ] **Step 5: Add CSS** (extend the `.file-badge` block ~line 1023):

```css
/* pkm-vcn6: badges with something to show are buttons */
button.file-badge { appearance: none; font-family: inherit;
  cursor: pointer; }
button.file-badge:hover { color: var(--color-text); }
button.file-badge:focus-visible { outline: 2px solid var(--color-link);
  outline-offset: 1px; }
button.file-badge.status-failed:hover { color: var(--color-error); }
```

(The hover keeps `status-failed` red — its resting color is the signal.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && pnpm test:unit src/views/Files.test.tsx && pnpm typecheck`
Expected: PASS, including the pre-existing badge assertions ("1 ref", `failed` with `title`).

- [ ] **Step 7: Commit** (tick bean checklist items 3–5)

```bash
git add web/src/views/Files.tsx web/src/views/Files.test.tsx web/src/styles.css .beans
git commit -m "pkm-vcn6: wire file-card badges to refs/description popovers"
```

---

### Task 6: Search placeholder mentions descriptions

**Files:**
- Modify: `web/src/views/Files.tsx` (the search input)
- Test: `web/src/views/Files.test.tsx`

The backend has always matched `q` against description AND filename (`routes_assets.py` `search_assets`); this is discoverability only.

- [ ] **Step 1: Update the test.** In the "styles the filter widgets" test, change `screen.getByLabelText("Search files")` to `screen.getByLabelText("Search names & descriptions")`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && pnpm test:unit src/views/Files.test.tsx`
Expected: that one test FAILS (label not found).

- [ ] **Step 3: Implement.** In `Files.tsx`, change the search input's `placeholder="Search files"` and `aria-label="Search files"` both to `"Search names & descriptions"`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && pnpm test:unit src/views/Files.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/views/Files.tsx web/src/views/Files.test.tsx .beans
git commit -m "pkm-vcn6: say the files search box covers descriptions"
```

---

### Task 7: E2E coverage + full verification

**Files:**
- Modify: `web/e2e/files.spec.ts`

**Interfaces:**
- Consumes: the UI shipped in Tasks 2 and 5; existing spec helpers `login`, `upload`, `PNG`.

- [ ] **Step 1: Append the e2e test** to `files.spec.ts`:

```ts
test("refs popover navigates; thumbnail expands in-app", async ({ page }) => {
  await login(page);
  const title = `Files Popover E2E ${Date.now()}`;
  const reffed = await upload(page, "reffed.png", PNG);
  await page.request.post("/api/pages", { data: { title } });
  const uid = `filespop${Date.now()}`;
  await page.request.post("/api/ops", {
    data: {
      client_id: "e2e", batch_id: `filespop-${uid}`,
      ops: [{ op: "create", uid, page_title: title, parent_uid: null,
              order_idx: 0, text: `sketch here ![](${reffed.url})` }],
    },
  });

  await page.goto("/files");
  const card = page.locator(".file-card", { hasText: "reffed.png" });
  await card.getByRole("button", { name: "1 ref" }).click();
  const popover = page.getByRole("dialog", { name: "References" });
  await expect(popover.getByText(title)).toBeVisible();
  await expect(popover.getByText(/sketch here/)).toBeVisible();
  // Corner-click: the row's center can land on inline content with its
  // own click handling (the pkm-7iv7 lesson).
  await popover.locator(".backlink-item").click({ position: { x: 4, y: 4 } });
  await page.waitForURL(`**/page/**#${uid}`);

  await page.goto("/files");
  await card.getByRole("button", { name: "Expand image: reffed.png" })
    .click();
  const overlay = page.getByRole("dialog", { name: /Expanded image/ });
  await expect(overlay).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
});
```

- [ ] **Step 2: Run the full verification**

Run: `cd web && pnpm verify`
Expected: typecheck clean, unit tests + coverage pass, all Playwright specs pass (verify builds first — never run e2e against a stale bundle). If the new e2e is flaky on load, prefer tightening waits (`await expect(...).toBeVisible()` before clicking) over retries.

- [ ] **Step 3: Commit** (tick bean checklist item 7)

```bash
git add web/e2e/files.spec.ts .beans
git commit -m "pkm-vcn6: e2e for refs popover and in-app image expansion"
```

---

### Task 8: Docs + bean completion

**Files:**
- Modify: `docs/architecture/frontend.md` (§ "The `/files` browser", ~line 206)
- Modify: the pkm-vcn6 bean file

- [ ] **Step 1: Invoke the `architecture-docs` skill** (required for any edit under `docs/architecture/`), then update the `/files` browser section. Two true statements need to change/land (verify against the code, not this plan):
  - The filter line "filters (text, type, date range, linked/orphan)" — text search covers filename and description; say so if the section implies filename-only.
  - Add one sentence for the card interactions, e.g.: cards expand images via the shared `ImageOverlay`, and the refs/status badges open popovers (refs resolved through `GET /api/block-refs`, rendered by `BacklinkGroupList` — the same single renderer the backlinks surfaces use).
  - Check `frontend.md` § Focus / popover notes: if popovers are enumerated anywhere (pkm-d31f's), the files popovers join the list.

- [ ] **Step 2: Complete the bean.** Tick the remaining checklist items, add a `## Summary of Changes` section (what shipped, file list, "no server changes — /api/block-refs reused"), and run `beans update pkm-vcn6 -s completed`.

- [ ] **Step 3: Final verification** — `cd web && pnpm verify` one last time on the branch tip; confirm clean `git status -sb`.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/frontend.md .beans
git commit -m "pkm-vcn6: document file-card popovers and search scope"
```

- [ ] **Step 5: Finish the branch** — invoke `superpowers:finishing-a-development-branch` (merge to main with `--no-ff` after review; deployment is a separate, user-initiated step).
