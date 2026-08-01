# pkm-6phf Low-Priority Cleanup Design

**Bean:** `pkm-6phf`  
**Child beans:** `pkm-p9em`, `pkm-xh61`

## Goal

Complete findings 15–17 in `pkm-6phf`: remove production-dead compatibility implementations, make Files supporting-note styling effective, and make disabled danger buttons visually consistent with disabled secondary buttons.

## Scope and branch structure

Work proceeds through integration branch `pkm-6phf-low` in its own worktree. Two independent implementation branches and worktrees start from that branch:

1. `pkm-6phf-low-dead-code` implements `pkm-p9em`.
2. `pkm-6phf-low-files-styles` implements `pkm-xh61`.

The two implementation branches are merged into the integration branch with `git merge --no-ff`. After combined verification and review, the integration branch is merged into `main` with `git merge --no-ff`.

Findings 16 and 17 share `styles.css`, `styles.test.ts`, `Files.test.tsx`, and the styling documentation, so they deliberately remain in one lane rather than creating conflict-prone branches.

## Lane A: remove dead compatibility paths

`web/src/components/BlockTree.tsx` and `web/src/outline/activeOutlines.ts` have no production importers. They parallel the active `EditableBlockTree` fallback renderer and `outlineSessions` lease API respectively, while preserving behavior that differs from runtime behavior.

The lane will:

- Add one focused `EditableBlockTree` fallback test retaining useful nested heading/link rendering and inert-interaction coverage that is not already covered by active implementation tests.
- Migrate tests that reserve an outline editor from `registerOutline()` to direct `acquireOutlineSession()` and `claimEditor()` usage, with explicit handle release in cleanup.
- Delete `BlockTree.tsx`, `BlockTree.test.tsx`, `activeOutlines.ts`, and `activeOutlines.test.ts`.
- Remove stale test comments that point to the deleted compatibility suite.
- Correct `docs/architecture/frontend.md` so it describes `EditableBlockTree` with `fallback=true` rather than the dead `BlockTree` renderer.

No runtime replacement module or new abstraction will be introduced. Existing active implementations remain the single source of behavior.

## Lane B: Files styling fixes

### Shared supporting notes

Files already applies `settings-note` to offline, notice, loading, error, and empty-result paragraphs, but the only rule is scoped beneath `.settings-section`. Change the selector to `p.settings-note` so the semantic class works in both Files and Settings.

The element qualifier is intentional: it ties the specificity of `.settings-section p`, and its later source order lets the compact note color and top margin win while retaining the earlier paragraph margin reset in Settings.

### Disabled danger buttons

Change the danger hover selector to `.btn-danger:hover:not(:disabled)`. Add `.btn-danger:disabled` with the same `opacity: 0.35` and `cursor: default` feedback used by secondary buttons. No Files runtime component change is needed because its toolbar Delete button already sets `disabled={busy}`.

### Documentation

Update the styling section of `docs/architecture/frontend.md` to record:

- `p.settings-note` is shared compact supporting/status copy across views.
- Both action-button families suppress hover feedback while disabled and use the same disabled opacity/cursor treatment.

## Testing

Each lane follows test-driven development.

Lane A first migrates/adds tests against active APIs, verifies they pass before deletion, then deletes compatibility code and reruns the focused suites. Focused coverage includes:

- `EditableBlockTree.test.tsx`
- `EditablePage.test.tsx`
- `EditableSidebarPanel.test.tsx`
- `EditableBlockTree.dnd.test.tsx`
- `outlineSessions.test.ts`

Lane B first adds assertions that fail against the current CSS:

- A stylesheet assertion requiring an exact top-level `p.settings-note` rule and rejecting `.settings-section p.settings-note`.
- Files component assertions binding representative offline and empty states to `settings-note`.
- Stylesheet assertions requiring guarded danger hover and disabled opacity/cursor declarations.
- A Files component test proving the toolbar danger action becomes disabled while deletion is pending.

Raw stylesheet assertions are used because jsdom does not reliably calculate CSS and layout. Component tests verify that runtime markup reaches the styled class/state contracts.

After both `--no-ff` merges, run the complete web gate from the integration worktree:

```bash
cd web && pnpm verify
```

A final whole-branch review checks the merged diff, architecture documentation, bean completion, and absence of stale imports before integration into `main`.

## Failure handling

The work changes no persisted data or network protocol. A failed focused or full test blocks merging that lane. Merge conflicts are resolved only on the integration branch, followed by rerunning affected focused tests and the complete `pnpm verify` gate. The epic is completed only when every finding checklist and child-bean checklist is checked and combined verification is green.
