# pkm-6phf Low-Priority Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete findings 15–17 in `pkm-6phf` by deleting dead web compatibility paths and correcting Files note and disabled-danger styling.

**Architecture:** Two isolated worktree branches implement independent lanes from integration branch `pkm-6phf-low`. The dead-code lane consolidates tests on existing active runtime APIs; the Files-styles lane adds source-level CSS contracts and component-state contracts before the minimal CSS changes. Both lanes update their child beans and architecture documentation, then merge into the integration branch with `--no-ff` for combined verification.

**Tech Stack:** React 19, TypeScript, Vitest/Testing Library, CSS, pnpm, beans, Git worktrees.

## Global Constraints

- Work only in isolated worktrees and named branches; never implement on `main`.
- Start both lane branches from integration commit `ba7aef8` or its descendant containing only plan/setup commits.
- Use test-driven development for behavior changes and retain only coverage of active runtime behavior.
- Do not add a replacement for `BlockTree` or `activeOutlines`; `EditableBlockTree` and `outlineSessions` remain authoritative.
- Every runtime file with behavior must retain its FCIS declaration; tests, CSS, docs, and bean files are exempt.
- Update `docs/architecture/frontend.md` in the same lane as the system/styling invariant it documents.
- Commit each child bean file with its lane’s code and mark it completed only after every child checklist item is checked.
- Merge each lane into `pkm-6phf-low`, and merge `pkm-6phf-low` into `main`, using `git merge --no-ff`.
- The combined release gate is `cd web && pnpm verify`.

---

## File map

### Lane A — `pkm-p9em`

- Delete `web/src/components/BlockTree.tsx`: production-dead renderer.
- Delete `web/src/components/BlockTree.test.tsx`: tests the dead renderer rather than runtime fallback behavior.
- Delete `web/src/outline/activeOutlines.ts`: production-dead legacy reservation facade.
- Delete `web/src/outline/activeOutlines.test.ts`: duplicates lease behavior covered by `outlineSessions.test.ts`.
- Modify `web/src/components/EditableBlockTree.test.tsx`: retain useful fallback rendering/inertness coverage.
- Modify `web/src/views/EditablePage.test.tsx`: reserve editor leases through `outlineSessions` directly and remove stale comments.
- Modify `web/src/components/EditableSidebarPanel.test.tsx`: reserve editor leases through `outlineSessions` directly.
- Modify `web/src/components/EditableBlockTree.dnd.test.tsx`: reserve editor leases through `outlineSessions` directly.
- Modify `docs/architecture/frontend.md`: describe the actual `EditableBlockTree fallback=true` invariant.
- Modify `.beans/pkm-p9em--remove-production-dead-web-compatibility-paths.md`: track and complete the lane.

### Lane B — `pkm-xh61`

- Modify `web/src/styles.test.ts`: define exact shared-note and disabled-danger stylesheet contracts.
- Modify `web/src/views/Files.test.tsx`: bind Files states to `settings-note` and verify pending deletion disables the danger action.
- Modify `web/src/styles.css`: promote `p.settings-note`; guard danger hover and style disabled danger actions.
- Modify `docs/architecture/frontend.md`: document shared supporting notes and disabled action-button invariants.
- Modify `.beans/pkm-xh61--fix-files-supporting-note-and-disabled-danger-styl.md`: track and complete the lane.

### Integration

- Modify `.beans/pkm-6phf--web-frontend-hardening-from-recent-change-review.md`: check findings 15–17, record child beans and verification, add a summary, and complete the epic.

---

### Task 1: Remove production-dead compatibility paths (`pkm-p9em`)

**Branch/worktree:** `pkm-6phf-low-dead-code` in `.worktrees/pkm-6phf-low-dead-code`

**Files:**
- Delete: `web/src/components/BlockTree.tsx`
- Delete: `web/src/components/BlockTree.test.tsx`
- Delete: `web/src/outline/activeOutlines.ts`
- Delete: `web/src/outline/activeOutlines.test.ts`
- Modify: `web/src/components/EditableBlockTree.test.tsx`
- Modify: `web/src/views/EditablePage.test.tsx`
- Modify: `web/src/components/EditableSidebarPanel.test.tsx`
- Modify: `web/src/components/EditableBlockTree.dnd.test.tsx`
- Modify: `docs/architecture/frontend.md`
- Modify: `.beans/pkm-p9em--remove-production-dead-web-compatibility-paths.md`

**Interfaces:**
- Consumes: `acquireOutlineSession(title: string, bootstrap: BlockNode[] | null): OutlineSessionHandle`, `OutlineSessionHandle.claimEditor(owner: symbol): EditorLease`, and `EditableBlockTree`’s `fallback` prop.
- Produces: no new runtime interface; all test reservations use the active outline-session lease contract.

- [ ] **Step 1: Start the child bean and establish the branch**

From the repository root:

```bash
git worktree add .worktrees/pkm-6phf-low-dead-code \
  -b pkm-6phf-low-dead-code pkm-6phf-low
cd .worktrees/pkm-6phf-low-dead-code
beans update pkm-p9em --status in-progress
```

- [ ] **Step 2: Add active fallback-renderer coverage before deleting the dead suite**

Add this focused test to `EditableBlockTree.test.tsx`:

```tsx
test("fallback renders nested rich text but exposes no editor controls", () => {
  const h = handlers();
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree
        blocks={[block("parent", "Papers", {
          heading: 2,
          children: [block("child", "read [[Paper]]")],
        })]}
        focus={null}
        handlers={h}
        readOnly={false}
        fallback
      />
    </MemoryRouter>,
  );

  expect(screen.getByText("Papers").closest("h2")).not.toBeNull();
  expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "toggle children" })[0])
    .toBeDisabled();
  const bullet = container.querySelector('[data-uid="parent"] .bullet');
  expect(bullet).not.toHaveAttribute("role");
  expect(bullet).not.toHaveAttribute("tabindex");
  fireEvent.click(screen.getByText("Papers"));
  expect(h.onFocusBlock).not.toHaveBeenCalled();
});
```

Remove the stale chevron-test comment that refers to `BlockTree.test.tsx` and replace it with a self-contained jsdom explanation.

Run:

```bash
cd web
pnpm test:unit src/components/EditableBlockTree.test.tsx \
  -t "fallback renders nested rich text"
```

Expected: PASS, proving the useful rendering/inertness behavior belongs to the active component before its dead counterpart is removed.

- [ ] **Step 3: Migrate test-only editor reservations to the active lease API**

In each of these files, replace the `activeOutlines` import with:

```ts
import { acquireOutlineSession } from "../outline/outlineSessions";
```

Where a file already imports from `outlineSessions`, add `acquireOutlineSession` to that import instead of creating a duplicate import.

Add this local helper to each of the three suites that reserves an external editor:

```ts
function reserveOutlineEditor(title: string): () => void {
  const handle = acquireOutlineSession(title, null);
  const lease = handle.claimEditor(Symbol(`test-reservation:${title}`));
  if (!lease.granted) throw new Error(`Could not reserve editor for ${title}`);
  return () => {
    lease.release();
    handle.release();
  };
}
```

Then make these exact substitutions while preserving each existing `try/finally` cleanup:

- Both `const release = registerOutline("Page");` lines in `EditablePage.test.tsx` become `const release = reserveOutlineEditor("Page");`.
- `const release = registerOutline("Paper");` in `EditableSidebarPanel.test.tsx` becomes `const release = reserveOutlineEditor("Paper");`.
- `const release = registerActiveOutline("P");` in `EditableBlockTree.dnd.test.tsx` becomes `const release = reserveOutlineEditor("P");`.

Also change the stale `EditablePage.test.tsx` comment from “see outline/activeOutlines.ts” to state that the atomic `outlineSessions` editor lease permits one editor per title.

Run:

```bash
cd web
pnpm exec vitest run \
  src/views/EditablePage.test.tsx \
  src/components/EditableSidebarPanel.test.tsx \
  src/components/EditableBlockTree.dnd.test.tsx \
  src/outline/outlineSessions.test.ts
```

Expected: PASS with no import of `activeOutlines` in those suites.

- [ ] **Step 4: Delete dead modules and obsolete suites**

Run:

```bash
rm web/src/components/BlockTree.tsx \
   web/src/components/BlockTree.test.tsx \
   web/src/outline/activeOutlines.ts \
   web/src/outline/activeOutlines.test.ts
rg -n 'BlockTree|activeOutlines|registerOutline|registerActiveOutline' \
  web/src --glob '!api/types.d.ts'
```

Expected: no import or symbol reference to either deleted compatibility path. References to `EditableBlockTree` are expected; a bare `BlockTree` module/import is not.

- [ ] **Step 5: Correct architecture documentation**

In `docs/architecture/frontend.md`, replace the sentence describing a read-only `BlockTree` bullet with this invariant:

```markdown
In `EditableBlockTree` fallback mode (`fallback=true`), bullets are inert spans
with no role, tab stop, menu, focus, upload, selection, or drag handlers, and
chevrons are disabled. The same renderer therefore displays the live shared
outline without creating a second editing implementation.
```

Do not rewrite historical specs, plans, or beans that record the old implementation.

- [ ] **Step 6: Run focused quality gates**

Run:

```bash
cd web
pnpm exec vitest run \
  src/components/EditableBlockTree.test.tsx \
  src/views/EditablePage.test.tsx \
  src/components/EditableSidebarPanel.test.tsx \
  src/components/EditableBlockTree.dnd.test.tsx \
  src/outline/outlineSessions.test.ts
pnpm typecheck
pnpm lint
pnpm check:fcis
```

Expected: all commands exit 0.

- [ ] **Step 7: Complete the child bean and commit**

Check all four checklist entries and append a `## Summary of Changes` section stating that the dead modules were deleted, tests now exercise active implementations, frontend architecture was corrected, and focused checks passed. Then mark the bean completed:

```bash
beans update pkm-p9em \
  --body-replace-old '- [ ] Add or migrate coverage to EditableBlockTree and outlineSessions APIs' \
  --body-replace-new '- [x] Add or migrate coverage to EditableBlockTree and outlineSessions APIs'
beans update pkm-p9em \
  --body-replace-old '- [ ] Remove dead compatibility modules and obsolete tests' \
  --body-replace-new '- [x] Remove dead compatibility modules and obsolete tests'
beans update pkm-p9em \
  --body-replace-old '- [ ] Update frontend architecture documentation' \
  --body-replace-new '- [x] Update frontend architecture documentation'
beans update pkm-p9em \
  --body-replace-old '- [ ] Run focused web checks and full verification' \
  --body-replace-new '- [x] Run focused web checks and full verification'
beans update pkm-p9em --status completed --body-append $'## Summary of Changes\n\nDeleted BlockTree and activeOutlines, moved retained coverage to EditableBlockTree and outlineSessions, corrected frontend architecture documentation, and passed the focused unit, type, lint, and FCIS checks. Full verification is recorded on the integration branch.'
git add web/src docs/architecture/frontend.md .beans/pkm-p9em--*.md
git commit -m "refactor(pkm-p9em): remove dead web compatibility paths"
```

Expected: the branch is clean and the child bean has no unchecked items.

---

### Task 2: Fix Files note and disabled-danger styling (`pkm-xh61`)

**Branch/worktree:** `pkm-6phf-low-files-styles` in `.worktrees/pkm-6phf-low-files-styles`

**Files:**
- Modify: `web/src/styles.test.ts`
- Modify: `web/src/views/Files.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `docs/architecture/frontend.md`
- Modify: `.beans/pkm-xh61--fix-files-supporting-note-and-disabled-danger-styl.md`

**Interfaces:**
- Consumes: Files’ existing `settings-note` classes and `<button className="btn-danger" disabled={busy}>` state.
- Produces: exact top-level `p.settings-note`, `.btn-danger:hover:not(:disabled)`, and `.btn-danger:disabled` CSS contracts.

- [ ] **Step 1: Start the child bean and establish the branch**

From the repository root:

```bash
git worktree add .worktrees/pkm-6phf-low-files-styles \
  -b pkm-6phf-low-files-styles pkm-6phf-low
cd .worktrees/pkm-6phf-low-files-styles
beans update pkm-xh61 --status in-progress
```

- [ ] **Step 2: Add failing stylesheet contracts**

Add this describe block to `web/src/styles.test.ts` near the existing control-polish tests:

```ts
describe("shared Files styling (pkm-6phf findings 16-17)", () => {
  test("settings-note styling is available outside Settings sections", () => {
    expect(styles).toContain("\np.settings-note {");
    expect(styles).not.toContain(".settings-section p.settings-note");

    const note = ruleFor("p.settings-note");
    expect(note).toContain("font-size: 13px;");
    expect(note).toContain("color: var(--color-text-muted);");
    expect(note).toContain("margin-top: 6px;");
  });

  test("disabled danger buttons match secondary disabled feedback", () => {
    expect(ruleFor(".btn-danger:hover:not(:disabled)"))
      .toContain("opacity: 0.9;");
    expect(styles).not.toContain(".btn-danger:hover {");

    const disabled = ruleFor(".btn-danger:disabled");
    expect(disabled).toContain("opacity: 0.35;");
    expect(disabled).toContain("cursor: default;");
  });
});
```

Run:

```bash
cd web
pnpm test:unit src/styles.test.ts -t "shared Files styling"
```

Expected: FAIL because the note selector is still Settings-scoped, danger hover is unguarded, and no danger-disabled rule exists.

- [ ] **Step 3: Bind Files markup/state to the CSS contracts**

Strengthen the existing offline and empty-state tests:

```ts
expect(screen.getByText(/needs a connection/i)).toHaveClass("settings-note");
expect(await screen.findByText(/no files match/i)).toHaveClass("settings-note");
```

Add this pending-deletion test after the existing successful deletion test:

```tsx
it("disables the danger action while deletion is pending", async () => {
  const pending = deferred<{ deleted: boolean; refs_removed: number }>();
  mockFetch
    .mockResolvedValueOnce(payload([item({})]))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(payload([]));
  render(<Files />);
  fireEvent.click(await screen.findByLabelText("Select pic.png"));

  const deleteButton = screen.getByRole("button", { name: "Delete" });
  expect(deleteButton).toHaveClass("btn-danger");
  fireEvent.click(deleteButton);
  fireEvent.click(await screen.findByRole("button", { name: "Delete file" }));

  await waitFor(() => expect(deleteButton).toBeDisabled());
  await act(async () => {
    pending.resolve({ deleted: true, refs_removed: 0 });
    await pending.promise;
  });
  expect(await screen.findByText("Deleted 1 file.")).toBeInTheDocument();
});
```

Run:

```bash
cd web
pnpm test:unit src/views/Files.test.tsx -t "offline note|empty state|danger action"
```

Expected: PASS before the CSS change, proving Files already emits the intended classes and disabled DOM state. The failing stylesheet test remains the RED behavior test.

- [ ] **Step 4: Implement the minimal CSS changes**

In `web/src/styles.css`, replace:

```css
.btn-danger:hover { opacity: 0.9; }
```

with:

```css
.btn-danger:hover:not(:disabled) { opacity: 0.9; }
.btn-danger:disabled { opacity: 0.35; cursor: default; }
```

Replace:

```css
.settings-section p.settings-note { font-size: 13px; color: var(--color-text-muted); margin-top: 6px; }
```

with:

```css
p.settings-note { font-size: 13px; color: var(--color-text-muted); margin-top: 6px; }
```

Run:

```bash
cd web
pnpm test:unit src/styles.test.ts -t "shared Files styling"
pnpm test:unit src/views/Files.test.tsx -t "offline note|empty state|danger action"
```

Expected: PASS.

- [ ] **Step 5: Document both styling invariants**

In `docs/architecture/frontend.md`’s styling section, add:

```markdown
`p.settings-note` is shared compact supporting/status copy across Settings and
Files. The `p` qualifier intentionally ties `.settings-section p` specificity;
its later source order lets muted note color and top margin win without losing
Settings’ paragraph margin reset.

Both `.btn-secondary` and `.btn-danger` suppress hover feedback with
`:not(:disabled)` and render disabled actions at `opacity: 0.35` with the
default cursor.
```

Keep the existing warning about `ruleFor()` and grouped/unanchored selectors.

- [ ] **Step 6: Run focused quality gates**

Run:

```bash
cd web
pnpm test:unit src/styles.test.ts src/views/Files.test.tsx
pnpm typecheck
pnpm lint
pnpm check:fcis
```

Expected: all commands exit 0.

- [ ] **Step 7: Complete the child bean and commit**

Check all five checklist entries and append a `## Summary of Changes` section stating that Files now reaches shared note styling, disabled danger feedback matches secondary buttons, documentation was updated, and focused checks passed. Then mark the bean completed:

```bash
beans update pkm-xh61 \
  --body-replace-old '- [ ] Add failing selector and disabled-state coverage' \
  --body-replace-new '- [x] Add failing selector and disabled-state coverage'
beans update pkm-xh61 \
  --body-replace-old '- [ ] Make settings-note styling reusable in Files' \
  --body-replace-new '- [x] Make settings-note styling reusable in Files'
beans update pkm-xh61 \
  --body-replace-old '- [ ] Make disabled danger-button feedback consistent' \
  --body-replace-new '- [x] Make disabled danger-button feedback consistent'
beans update pkm-xh61 \
  --body-replace-old '- [ ] Update frontend architecture documentation' \
  --body-replace-new '- [x] Update frontend architecture documentation'
beans update pkm-xh61 \
  --body-replace-old '- [ ] Run focused web checks and full verification' \
  --body-replace-new '- [x] Run focused web checks and full verification'
beans update pkm-xh61 --status completed --body-append $'## Summary of Changes\n\nPromoted supporting-note styling for Files, aligned disabled danger-button feedback with secondary controls, added stylesheet and Files state coverage, updated frontend architecture documentation, and passed focused checks. Full verification is recorded on the integration branch.'
git add web/src/styles.css web/src/styles.test.ts web/src/views/Files.test.tsx \
  docs/architecture/frontend.md .beans/pkm-xh61--*.md
git commit -m "fix(pkm-xh61): correct Files supporting and danger styles"
```

Expected: the branch is clean and the child bean has no unchecked items.

---

### Task 3: Integrate, review, verify, and complete `pkm-6phf`

**Branch/worktree:** `pkm-6phf-low` in `.worktrees/pkm-6phf-low`

**Files:**
- Modify: `.beans/pkm-6phf--web-frontend-hardening-from-recent-change-review.md`
- Verify merged changes from Tasks 1 and 2.

**Interfaces:**
- Consumes: reviewed commits from `pkm-6phf-low-dead-code` and `pkm-6phf-low-files-styles`.
- Produces: a verified integration branch and completed epic ready for `--no-ff` merge to `main`.

- [ ] **Step 1: Review both lane diffs independently**

For each branch, compare against `pkm-6phf-low`, inspect the child bean and architecture changes, and require both spec compliance and code-quality approval:

```bash
git diff --check pkm-6phf-low...pkm-6phf-low-dead-code
git diff --stat pkm-6phf-low...pkm-6phf-low-dead-code
git diff --check pkm-6phf-low...pkm-6phf-low-files-styles
git diff --stat pkm-6phf-low...pkm-6phf-low-files-styles
```

Any Critical or Important review finding must be fixed by the responsible lane subagent and re-reviewed before merging.

- [ ] **Step 2: Merge both lanes with preserved branch history**

From the integration worktree:

```bash
git merge --no-ff pkm-6phf-low-dead-code \
  -m "Merge pkm-6phf dead compatibility cleanup (pkm-p9em)"
git merge --no-ff pkm-6phf-low-files-styles \
  -m "Merge pkm-6phf Files styling cleanup (pkm-xh61)"
```

If `docs/architecture/frontend.md` conflicts, retain both non-overlapping invariants: fallback renderer behavior and the two Files/control styling rules.

- [ ] **Step 3: Run merged focused checks and the complete web gate**

Run:

```bash
cd web
pnpm exec vitest run \
  src/components/EditableBlockTree.test.tsx \
  src/views/EditablePage.test.tsx \
  src/components/EditableSidebarPanel.test.tsx \
  src/components/EditableBlockTree.dnd.test.tsx \
  src/outline/outlineSessions.test.ts \
  src/styles.test.ts \
  src/views/Files.test.tsx
pnpm verify
```

Expected: focused suites and every verify phase pass. Record exact counts from the final output in the epic summary rather than copying stale counts from prior runs.

- [ ] **Step 4: Complete the epic**

In `.beans/pkm-6phf--web-frontend-hardening-from-recent-change-review.md`:

- Check both finding-15 items, both finding-16 items, and both finding-17 items.
- Add `Done in pkm-p9em.` beneath finding 15.
- Add `Done in pkm-xh61.` beneath findings 16 and 17.
- Add a `## Summary of Changes` section describing all three completed findings and the exact merged `pnpm verify` result.
- Mark `pkm-6phf` completed only after confirming there are no unchecked checklist items.

Run:

```bash
beans update pkm-6phf --status completed
rg -n -- '- \[ \]' .beans/pkm-6phf--*.md
```

Expected: the bean status is completed and the unchecked-item search returns no matches.

Commit:

```bash
git add .beans/pkm-6phf--*.md
git commit -m "docs(pkm-6phf): complete frontend hardening cleanup"
```

- [ ] **Step 5: Perform final whole-branch review**

Review the full integration diff against `main`, including deletion safety, CSS specificity, active API cleanup, tests, docs, and beans:

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
rg -n 'from ["'"'].*(BlockTree|activeOutlines)["'"']|registerOutline|registerActiveOutline' \
  web/src || true
git status --short --branch
```

Dispatch one final capable reviewer. If it reports findings, use one fix subagent for the complete finding list, run covering tests, and perform one scoped re-review.

- [ ] **Step 6: Merge the verified integration branch into `main`**

From the main checkout, first confirm it is clean and still at the expected ancestor, then merge:

```bash
git status --short --branch
git merge --no-ff pkm-6phf-low \
  -m "Merge pkm-6phf low-priority frontend hardening cleanup"
git status --short --branch
git log --oneline --decorate -6
```

Expected: clean `main`, a merge commit preserving both lane branches through the integration branch, and completed bean files included in history.
