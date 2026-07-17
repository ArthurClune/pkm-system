# Uploaded Image Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users click uploaded `/assets/` images to inspect them in an accessible, viewport-fitting fullscreen modal.

**Architecture:** Extend the existing Imperative Shell `AssetImage` component with local expansion state and a portalled modal, leaving external images unchanged. The modal mirrors the established PDF interaction contract—focus entry/restoration, Escape, focus containment, body scroll lock, click containment—but does not refactor the PDF viewer or introduce shared infrastructure.

**Tech Stack:** React 18, TypeScript, ReactDOM portals, Testing Library/Vitest, CSS, Playwright.

## Global Constraints

- Expansion applies only when `src` begins with `/assets/`; external images remain non-expandable.
- The expanded image uses `object-fit: contain`, preserves aspect ratio, and is never cropped.
- Close mechanisms are the visible Close button, Escape, and empty-stage/backdrop click.
- Zoom, pan, captions, downloads, image navigation, new dependencies, and PDF viewer refactoring are out of scope.
- Keep runtime behavior in the existing `// pattern: Imperative Shell` component; no new Functional Core module is needed.
- Preserve the existing offline failure placeholder and reset behavior when `src` changes.

## File Structure

- Modify `web/src/components/AssetImage.tsx`: asset eligibility, expansion state, portal markup, modal effects, failure handling, and event containment.
- Modify `web/src/components/AssetImage.test.tsx`: component behavior, accessibility, focus, scroll lock, error recovery, and propagation regressions.
- Modify `web/src/styles.css`: trigger, overlay, header, stage, and contained-image styling.
- Modify `web/src/styles.test.ts`: structural assertions for viewport overlay and non-cropping image rules.
- Create `web/e2e/image-expansion.spec.ts`: real-browser uploaded-image expansion, keyboard operation, viewport fit, and close paths.
- Modify `.beans/pkm-aze9--image-expansion.md`: keep implementation and verification tracking current and record the final summary.

---

### Task 1: Accessible uploaded-image modal behavior

**Files:**
- Modify: `web/src/components/AssetImage.tsx`
- Modify: `web/src/components/AssetImage.test.tsx`

**Interfaces:**
- Consumes: existing `AssetImage({ src, alt }: { src: string; alt: string })` callers and `/assets/` URL convention.
- Produces: the unchanged `AssetImage` public signature; `.asset-image-trigger`, `.image-overlay`, `.image-overlay-bar`, `.image-overlay-stage`, and `.image-overlay-image` DOM hooks used by Task 2.

- [ ] **Step 1: Replace the component test file with behavior-first coverage**

Write `web/src/components/AssetImage.test.tsx` as:

```tsx
import { afterEach, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AssetImage } from "./AssetImage";

const ASSET = "/assets/abc/photo.png";

afterEach(() => {
  document.body.style.overflow = "";
});

function openImage(alt = "photo") {
  render(<AssetImage src={ASSET} alt={alt} />);
  const trigger = screen.getByRole("button", { name: `Expand image: ${alt}` });
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: `Expanded image: ${alt}` }) };
}

it("renders an uploaded image as an accessible expansion trigger", () => {
  render(<AssetImage src={ASSET} alt="photo" />);
  const trigger = screen.getByRole("button", { name: "Expand image: photo" });
  const img = screen.getByRole("img", { name: "photo" });
  expect(trigger).toContainElement(img);
  expect(img).toHaveAttribute("src", ASSET);
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Expanded image: photo" }))
    .toHaveAttribute("aria-modal", "true");
});

it("uses fallback accessible names when alt text is empty", () => {
  render(<AssetImage src={ASSET} alt="" />);
  fireEvent.click(screen.getByRole("button", { name: "Expand image" }));
  expect(screen.getByRole("dialog", { name: "Expanded image" })).toBeInTheDocument();
});

it("leaves external images non-expandable", () => {
  render(<AssetImage src="https://example.test/photo.png" alt="external" />);
  expect(screen.getByRole("img", { name: "external" })).toHaveAttribute(
    "src", "https://example.test/photo.png");
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("closes through Close, Escape, and an empty-stage click only", () => {
  const { trigger } = openImage();
  fireEvent.click(document.querySelector(".image-overlay-bar")!);
  fireEvent.click(screen.getAllByRole("img", { name: "photo" })[1]);
  expect(screen.getByRole("dialog")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(trigger);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(trigger);
  fireEvent.click(document.querySelector(".image-overlay-stage")!);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("moves focus into the modal, traps Tab, restores focus, and restores body overflow", () => {
  document.body.style.overflow = "auto";
  render(<AssetImage src={ASSET} alt="photo" />);
  const trigger = screen.getByRole("button", { name: "Expand image: photo" });
  trigger.focus();
  fireEvent.click(trigger);
  const close = screen.getByRole("button", { name: "Close" });
  expect(close).toHaveFocus();
  expect(document.body.style.overflow).toBe("hidden");

  close.blur();
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(close).toHaveFocus();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(document.body.style.overflow).toBe("auto");
});

it("restores body overflow when unmounted while expanded", () => {
  document.body.style.overflow = "scroll";
  const { unmount } = render(<AssetImage src={ASSET} alt="photo" />);
  fireEvent.click(screen.getByRole("button", { name: "Expand image: photo" }));
  expect(document.body.style.overflow).toBe("hidden");
  unmount();
  expect(document.body.style.overflow).toBe("scroll");
});

it("contains trigger and portalled-overlay clicks inside the interactive island", () => {
  const onParentClick = vi.fn();
  render(
    <div onClick={onParentClick}>
      <AssetImage src={ASSET} alt="photo" />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand image: photo" }));
  expect(onParentClick).not.toHaveBeenCalled();

  fireEvent.click(screen.getAllByRole("img", { name: "photo" })[1]);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(onParentClick).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onParentClick).not.toHaveBeenCalled();
});

it("shows the existing placeholder when either image fails", () => {
  const inline = render(<AssetImage src={ASSET} alt="photo" />);
  fireEvent.error(screen.getByRole("img", { name: "photo" }));
  expect(screen.getByText(/image unavailable offline/i)).toHaveTextContent("photo");
  inline.unmount();

  render(<AssetImage src={ASSET} alt="photo" />);
  fireEvent.click(screen.getByRole("button", { name: "Expand image: photo" }));
  fireEvent.error(screen.getAllByRole("img", { name: "photo" })[1]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText(/image unavailable offline/i)).toHaveTextContent("photo");
});

it("closes expansion on a source change and recovers from a prior failure", () => {
  const { rerender } = render(<AssetImage src="/assets/a/x.png" alt="x" />);
  fireEvent.click(screen.getByRole("button", { name: "Expand image: x" }));
  rerender(<AssetImage src="/assets/b/y.png" alt="y" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("img", { name: "y" })).toHaveAttribute("src", "/assets/b/y.png");

  fireEvent.error(screen.getByRole("img", { name: "y" }));
  expect(screen.queryByRole("img")).toBeNull();
  rerender(<AssetImage src="/assets/c/z.png" alt="z" />);
  expect(screen.getByRole("img", { name: "z" })).toHaveAttribute("src", "/assets/c/z.png");
});
```

- [ ] **Step 2: Run the focused tests and verify the red state**

Run:

```bash
cd web && pnpm test:unit -- src/components/AssetImage.test.tsx
```

Expected: FAIL because uploaded images do not yet render an expansion button or dialog.

- [ ] **Step 3: Implement the modal in `AssetImage`**

Replace `web/src/components/AssetImage.tsx` with:

```tsx
// pattern: Imperative Shell
// Uploaded-asset image. Viewed assets are runtime-cached by the service
// worker (spec section 5); one that was never viewed can't load offline,
// so a failed load renders a labelled placeholder instead of a broken img.
// Uploaded /assets/ images also own an accessible fullscreen expansion
// overlay; both behaviors coordinate React state and DOM effects.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function isUploadedAsset(src: string): boolean {
  return src.startsWith("/assets/");
}

export function AssetImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // A new src deserves a fresh attempt and must not leave the old image open.
  useEffect(() => {
    setFailed(false);
    setExpanded(false);
  }, [src]);

  useEffect(() => {
    if (!expanded) return;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
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
  }, [expanded]);

  const onError = () => {
    setExpanded(false);
    setFailed(true);
  };

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
  const dialogLabel = alt ? `Expanded image: ${alt}` : "Expanded image";

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
      {expanded && createPortal(
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
              onClick={() => setExpanded(false)}
            >
              Close
            </button>
          </div>
          <div
            className="image-overlay-stage"
            onClick={(event) => {
              if (event.target === event.currentTarget) setExpanded(false);
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
      )}
    </>
  );
}
```

- [ ] **Step 4: Run the focused tests and verify the green state**

Run:

```bash
cd web && pnpm test:unit -- src/components/AssetImage.test.tsx
```

Expected: all `AssetImage` tests PASS.

- [ ] **Step 5: Run type, lint, and FCIS checks for the component change**

Run:

```bash
cd web && pnpm typecheck && pnpm lint && pnpm check:fcis
```

Expected: all three commands exit 0 with no diagnostics.

- [ ] **Step 6: Commit the behavior**

```bash
git add web/src/components/AssetImage.tsx web/src/components/AssetImage.test.tsx
git commit -m "feat(web): expand uploaded images in a modal (pkm-aze9)"
```

---

### Task 2: Viewport styling and real-browser coverage

**Files:**
- Modify: `web/src/styles.css`
- Modify: `web/src/styles.test.ts`
- Create: `web/e2e/image-expansion.spec.ts`

**Interfaces:**
- Consumes: Task 1 DOM classes `.asset-image-trigger`, `.image-overlay`, `.image-overlay-bar`, `.image-overlay-stage`, and `.image-overlay-image`.
- Produces: fixed fullscreen layout, visible trigger focus, fit-without-cropping image presentation, and Playwright regression coverage.

- [ ] **Step 1: Add failing structural CSS tests**

Append this block to `web/src/styles.test.ts`:

```ts
describe("uploaded image expansion (pkm-aze9)", () => {
  test("the uploaded-image trigger preserves layout and has visible keyboard focus", () => {
    const trigger = ruleFor(".asset-image-trigger");
    expect(trigger).toContain("display: block;");
    expect(trigger).toContain("max-width: 100%;");
    expect(trigger).toContain("cursor: zoom-in;");
    expect(ruleFor(".asset-image-trigger:focus-visible"))
      .toContain("outline: 2px solid var(--color-link);");
  });

  test("the overlay fills the viewport and the image is contained without cropping", () => {
    const overlay = ruleFor(".image-overlay");
    expect(overlay).toContain("position: fixed;");
    expect(overlay).toContain("inset: 0;");
    const image = ruleFor(".image-overlay-image");
    expect(image).toContain("max-width: 100%;");
    expect(image).toContain("max-height: 100%;");
    expect(image).toContain("object-fit: contain;");
  });
});
```

- [ ] **Step 2: Run the CSS tests and verify the red state**

Run:

```bash
cd web && pnpm test:unit -- src/styles.test.ts
```

Expected: FAIL with `Missing CSS rule for .asset-image-trigger`.

- [ ] **Step 3: Add the real-browser expansion scenario**

Create `web/e2e/image-expansion.spec.ts`:

```ts
// Uploaded-image fullscreen expansion: upload a real image, embed it in a
// block, and verify modal sizing, keyboard access, and every close path.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");
const caretToEnd = (page: Page) =>
  input(page).evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length));

test("uploaded image expands to a contained fullscreen modal", async ({ page }) => {
  await login(page);
  const response = await page.request.post("/api/assets", {
    multipart: { file: { name: "pic.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(response.ok()).toBe(true);
  const { url } = await response.json() as { url: string };

  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();
  const startWriting = today.getByText("Click to start writing…");
  if (await startWriting.count() > 0) {
    await startWriting.click();
  } else {
    await today.locator(".block-text").first().click();
    await caretToEnd(page);
    await input(page).press("Enter");
  }
  await input(page).fill(`![pic](${url})`);
  await input(page).press("Escape");

  const trigger = page.getByRole("button", { name: "Expand image: pic" });
  await expect(trigger.getByRole("img", { name: "pic" })).toBeVisible();

  // Native button semantics make Enter open the same viewer as a click.
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Expanded image: pic" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");

  const fit = await dialog.evaluate((element) => {
    const stage = element.querySelector<HTMLElement>(".image-overlay-stage")!;
    const image = element.querySelector<HTMLElement>(".image-overlay-image")!;
    const stageRect = stage.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    return {
      objectFit: getComputedStyle(image).objectFit,
      inside:
        imageRect.left >= stageRect.left &&
        imageRect.top >= stageRect.top &&
        imageRect.right <= stageRect.right &&
        imageRect.bottom <= stageRect.bottom,
    };
  });
  expect(fit).toEqual({ objectFit: "contain", inside: true });

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");

  await trigger.click();
  await dialog.locator(".image-overlay-stage").click({ position: { x: 2, y: 2 } });
  await expect(dialog).toHaveCount(0);

  await trigger.click();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});
```

- [ ] **Step 4: Implement the image expansion styles**

Replace the existing single `.asset-image` rule in `web/src/styles.css` with:

```css
.asset-image { max-width: 100%; border-radius: var(--radius-card); display: block; margin: 4px 0; }
.asset-image-trigger { appearance: none; display: block; max-width: 100%; margin: 4px 0;
  padding: 0; border: 0; border-radius: var(--radius-card); background: transparent;
  color: inherit; font: inherit; line-height: 0; text-align: left; cursor: zoom-in; }
.asset-image-trigger .asset-image { margin: 0; }
.asset-image-trigger:focus-visible { outline: 2px solid var(--color-link); outline-offset: 2px; }
.image-overlay { position: fixed; inset: 0; z-index: 1000;
  display: flex; flex-direction: column; background: rgb(0 0 0 / 88%); }
.image-overlay-bar { display: flex; justify-content: flex-end;
  padding: 8px 16px; border-bottom: 1px solid var(--color-border);
  background: var(--color-bg); }
.image-overlay-stage { flex: 1; min-width: 0; min-height: 0; display: flex;
  align-items: center; justify-content: center; padding: 16px; cursor: zoom-out; }
.image-overlay-image { display: block; max-width: 100%; max-height: 100%;
  width: auto; height: auto; object-fit: contain; cursor: default; }
```

Keep `.asset-image-placeholder` immediately after these rules unchanged.

- [ ] **Step 5: Run unit, style, and browser tests**

Run:

```bash
cd web && pnpm test:unit -- src/components/AssetImage.test.tsx src/styles.test.ts
pnpm e2e -- image-expansion.spec.ts
```

Expected: both commands exit 0; the focused Vitest files and the image-expansion Playwright test PASS.

- [ ] **Step 6: Commit styling and E2E coverage**

```bash
git add web/src/styles.css web/src/styles.test.ts web/e2e/image-expansion.spec.ts
git commit -m "test(web): cover uploaded image expansion end to end (pkm-aze9)"
```

---

### Task 3: Full verification, review, and bean handoff

**Files:**
- Modify: `.beans/pkm-aze9--image-expansion.md`

**Interfaces:**
- Consumes: the complete Task 1 and Task 2 implementation.
- Produces: verified branch state, review evidence, updated bean checklist/summary, and a pushed branch ready for the finishing workflow.

- [ ] **Step 1: Run the repository-required full web verification**

Run:

```bash
cd web && pnpm verify
```

Expected: typecheck, lint, FCIS check, enforced unit coverage, production build, and all Playwright tests exit 0.

- [ ] **Step 2: Invoke the requesting-code-review skill**

Request review of the branch diff from the design commit through `HEAD`, explicitly checking:

- uploaded-only eligibility;
- modal focus, scroll, Escape, backdrop, and propagation behavior;
- failure/source-change cleanup;
- CSS viewport containment;
- unit and E2E false-positive risk;
- FCIS classification and scope adherence.

Expected: no unresolved Critical or Important findings. Address any concrete findings with a failing regression test first, then rerun the focused test before committing the correction.

- [ ] **Step 3: Rerun full verification after review**

Run again after the review, even when no corrections were required:

```bash
cd web && pnpm verify
```

Expected: the complete command exits 0 with fresh post-review evidence.

- [ ] **Step 4: Update the bean implementation and verification record**

From the repository worktree root, run:

```bash
beans update pkm-aze9 \
  --body-replace-old "- [ ] Write and approve the implementation plan" \
  --body-replace-new "- [x] Write and approve the implementation plan"
beans update pkm-aze9 \
  --body-replace-old "- [ ] Implement via TDD in an isolated worktree" \
  --body-replace-new "- [x] Implement via TDD in an isolated worktree"
beans update pkm-aze9 \
  --body-replace-old "- [ ] Run required verification and review" \
  --body-replace-new "- [x] Run required verification and review"
beans update pkm-aze9 --body-append $'## Summary of Changes\n\nImplemented uploaded `/assets/` image expansion with a portalled, viewport-contained modal. Added keyboard and pointer opening, Close/Escape/backdrop closing, modal focus containment and restoration, body scroll lock, editable-block click containment, preserved offline failure recovery, CSS coverage, and a real uploaded-image Playwright scenario. Verified with `cd web && pnpm verify` and completed code review.'
```

Then inspect the bean and confirm the final integration checklist item remains unchecked until the branch has actually been merged and pushed:

```bash
beans show --json pkm-aze9
```

- [ ] **Step 5: Commit and push the verified branch**

```bash
git add .beans/pkm-aze9--image-expansion.md
git commit -m "chore(beans): record pkm-aze9 verification"
git push
```

Expected: the feature branch is up to date on `origin` with a clean worktree.

- [ ] **Step 6: Enter the finishing workflow**

Invoke `superpowers:verification-before-completion`, confirm the fresh `pnpm verify` evidence and clean status, then invoke `superpowers:finishing-a-development-branch`. For local integration, merge with `git merge --no-ff feat/pkm-aze9-image-expansion`, push `main`, check the bean's final integration item, add completion notes, set `pkm-aze9` to `completed`, commit/push that bean update, and remove the worktree/branch only after the remote contains all commits.
