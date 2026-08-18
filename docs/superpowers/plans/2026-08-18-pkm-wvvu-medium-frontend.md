# pkm-wvvu medium-priority frontend follow-ups — execution plan

**Date:** 2026-08-18
**Epic:** `pkm-wvvu` — implementation quality follow-ups from the 2026-08-17 reviews.
**Spec:** each task's bean body (acceptance criteria copied verbatim below) plus
`docs/2026-08-17-implementation-review-frontend.md`, which is the review that
sourced every finding. The review doc is the binding authority on what the
finding *is*; the bean is the binding authority on what done means.

This plan covers the six normal-priority **frontend** children of the epic:
`pkm-3lqg`, `pkm-nqve`, `pkm-d5re`, `pkm-2i6a`, `pkm-jk21`, `pkm-nvxh`.
(The other normal-priority children — byig, 9w4f, 2771 — are backend/CLI and out of scope.)

## Lanes and ordering

Four independent lanes, each in its own worktree under `.worktrees/`, all
branched from `main` at `3d7cbb1`. Within a lane, tasks are sequential because
they touch the same files; across lanes there is no production-file overlap
(architecture docs may conflict at merge time; the controller resolves that).

| Lane | Worktree | Branch | Tasks | E2E_PORT |
|---|---|---|---|---|
| 1 | `.worktrees/pkm-3lqg-backlinks` | `pkm-3lqg-backlinks-pagination` | Task 1 | 8981 |
| 2 | `.worktrees/pkm-nqve-recovery` | `pkm-nqve-recovery-lifecycle` | Task 2 | 8982 |
| 3 | `.worktrees/pkm-d5re-2i6a-chrome` | `pkm-d5re-topbar-delete-errors`, then `pkm-2i6a-popover-shell` | Task 3 → Task 4 | 8983 |
| 4 | `.worktrees/pkm-jk21-nvxh-outline` | `pkm-jk21-loader-replay`, then `pkm-nvxh-outline-hot-paths` | Task 5 → Task 6 | 8984 |

## Global constraints

- **Worktree pinning.** All work happens inside the lane's worktree root
  (absolute path given in the dispatch). Run `git status -sb` before every
  commit and abort if the branch or root is not the lane's own. Never edit
  the main checkout at `/Users/arthur/code/llm/pkm`.
- **TDD.** Write the failing test first for every behaviour change; the bean
  criteria that say "add tests that would fail if X" mean exactly that —
  demonstrate the red state before the fix/refactor.
- **FCIS.** Every new runtime file declares `# pattern: Functional Core` or
  `# pattern: Imperative Shell` (comment syntax of its language, near the top).
  Pure policy goes in core files; DOM/network/storage stays in shells.
- **Verification gate** before claiming done, from the worktree:
  `cd web && pnpm typecheck && pnpm test:unit` during development, and a full
  `CI=true E2E_PORT=<lane port> pnpm verify` at the end. Never use port 8974
  (production) or 8975 (another lane may hold the default).
- **Architecture docs.** `docs/architecture/frontend.md` and
  `sync-and-offline.md` describe the system as it is; update them in the same
  branch when a boundary, module, or invariant changes. Prefer a table row or
  diagram edit over new prose; delete prose the change obsoletes.
- **Beans.** At start: `beans update <id> -s in-progress` from the worktree
  root. As you work, tick the bean's acceptance checkboxes. At end: append a
  `## Summary of Changes` section and set status completed. Commit the bean
  file (`.beans/…`) together with the code.
- **Commits.** Match repo style (`fix(scope): message (bean-id)` /
  `refactor(scope): …`). `Co-Authored-By: Claude …` is fine; NEVER a
  `Claude-Session:` trailer or claude.ai URL (a commit-msg hook rejects it).
- **No scope creep.** Do not fix findings belonging to other tasks/lanes even
  when you see them; note them in your report instead.

## Task 1: pkm-3lqg — Unify BacklinksSection pagination and state updates

**Bean:** `pkm-3lqg`. **Review finding A4** (`docs/2026-08-17-implementation-review-frontend.md`).

`web/src/components/BacklinksSection.tsx`: `loadAll` (~:83-112) and `refresh`'s
inner loop (~:118-142) are the same "fetch batches of 100, `mergeGroups`,
epoch-guard, bail on no-growth" algorithm, already drifting subtly.
`groups`/`totalPages`/`extraRefTexts` are set in lockstep as three separate
`useState`s in 4 places — a partial update can't be caught by the type system.

Acceptance criteria (from the bean, binding):

- Extract one tested backlink batch-walk used by initial load and refresh
- Keep epoch/supersession checks at every asynchronous boundary
- Store groups, total page count, and extra reference texts as one atomic state value
- Preserve incremental pagination, deduplication, ordering, refresh, and no-growth termination
- Add tests for stale refreshes, multi-batch results, duplicates, and partial failures

Notes: the batch-walk should be a pure-ish core function (FCIS) driven by an
injected fetch, so the stale/multi-batch/duplicate/partial-failure tests need
no component mount where possible; keep component-level coverage for the
epoch-guard wiring.

## Task 2: pkm-nqve — Share replica recovery lifecycles and tighten reset contracts

**Bean:** `pkm-nqve`. **Review finding A5 (recovery half).**

`web/src/sync/replicaSync.ts`: `resetLocalData` (~:397-445) re-implements
`runRecovery`'s (~:193-231) prepare → flush → snapshot → commit → resume lease
lifecycle with three deltas (`ResetBlockedError`, `started = true`, forced
ready). A lease-handling change must now be made twice.

Acceptance criteria (binding):

- Extract a shared recovery-lease protocol or extend `runRecovery` with explicit reset options
- Represent `ResetBlockedError`, started-state, and forced-ready differences as named options or results rather than duplicated control flow
- Guarantee resume/finalization on every success, failure, and cancellation path
- Preserve pending operations and availability state according to current recovery policy
- Add deterministic tests for reset, recovery, blocked reset, snapshot failure, commit failure, and cleanup ordering
- Update sync-and-offline architecture documentation

Danger zone: this file hosts incident-derived invariants. Do not weaken the
poison-intent retention, the once-latched failed-open (`dbPromise` latch — only
`close()` re-arms), or availability transitions. Behaviour must be preserved
exactly; this is a dedup refactor plus tests, not a policy change.

## Task 3: pkm-d5re — Surface page deletion failures in TopBar

**Bean:** `pkm-d5re` (bug). **Review correctness-adjacent flag.**

`web/src/components/TopBar.tsx` ~:46-58 — a confirmed page delete that fails is
completely silent: `catch { deleted = false }`, the menu closes, nothing is
shown. Every sibling (`PageTitle`, `SidebarNav`, `Files`) surfaces errors.

Acceptance criteria (binding):

- Keep the failed page visible and surface an actionable deletion error through TopBar or the confirmation flow
- Clear or supersede stale errors on a later attempt/navigation as appropriate
- Preserve successful deletion navigation and menu behavior
- Add component coverage for success, failure, retry, and accessible error announcement
- Reuse an existing application error pattern rather than inventing a second notification system

Notes: read how `PageTitle`, `SidebarNav`, and `Files` surface errors first and
copy the strongest existing pattern. The iPad PWA suppresses `window.confirm`;
this app has a `useConfirm` abstraction — whatever you touch must keep working
through it.

## Task 4: pkm-2i6a — Build shared popover chrome and dismissal behavior

**Bean:** `pkm-2i6a`. **Review finding A2.** Runs after Task 3 in the same
worktree (both touch TopBar); branch `pkm-2i6a-popover-shell` off the completed
Task 3 branch.

`web/src/views/FileCardPopovers.tsx` (`CardPopover`, ~:26-69) re-implements
`web/src/components/BlockRefBacklinksPopover.tsx` (~:25-83) near-verbatim —
measure via `useLayoutEffect` + `clampPopoverPosition`, outside-mousedown
dismiss, Escape dismiss, same `role="dialog"` class. Separately the
outside-click+Escape dismissal effect is hand-rolled in five components
(SearchBar ~:96-111, TopBar ~:60-75, BlockMenu ~:21-40, and both popovers).
The `remeasure` need is the only delta between the two popovers.

Acceptance criteria (binding):

- Add a shared Popover shell beside `popoverPosition.ts` with explicit support for the required remeasurement difference
- Add a reusable dismissal hook for outside pointer interaction and Escape
- Migrate both popovers plus SearchBar, TopBar, and BlockMenu where semantics match
- Keep BlockMenu roving-focus keyboard behavior separate and intact
- Preserve viewport clamping, focus behavior, propagation, roles, and file-reference navigation with component and browser coverage
- Update frontend architecture/component guidance if the shared boundary becomes canonical

Notes: "where semantics match" is a real gate — if a component's dismissal
differs deliberately (event phase, target filtering), do not force it through
the hook; document why it stays hand-rolled. "Browser coverage" means the
Playwright e2e suite must exercise at least one migrated popover's dismiss
path; extend an existing spec rather than adding a new serial spec if one
already opens these popovers. Portal bubbling gotcha: portals create
interactive islands — outside-click detection must account for portal
containment, as the existing components already do.

## Task 5: pkm-jk21 — Make outline loading and write-replay policies explicit and type-safe

**Bean:** `pkm-jk21`. **Review findings A3, B2, B3, and the `transitionOutline` exhaustiveness observation.**

- A3: `web/src/outline/missingPage.ts` is documented as *the* statement of
  "404 on a daily = empty page," but `outline/useOutline.ts` ~:110-113
  re-inlines the predicate in its registered loader — and that loader, not the
  view-level guard, is what repair epochs and remote-ops catch-up hit.
- B2: `outline/outlineState.ts` ~:43-44 gives `write-started` both `replay?`
  and `ops?`; no caller ever sends `ops`. `trackWrite`'s `replay = []` default
  (`outlineSessions.ts` ~:433) means `applyLocal`'s call (~:701) would
  overwrite the real replay recorded by its own `local-ops` transition — safe
  today only because `SyncProvider.tsx` ~:630-633 pre-tracks every write, a
  cross-module ordering invariant nothing asserts.
- B3: three `setAuthoritativeLoader` sites (`useOutline.ts` ~:99,
  `useOutlinePageLoad.ts` ~:165, `Journal.tsx` ~:67); selection is
  last-mounted-wins — an implicit temporal contract.
- `transitionOutline` (~112 L) handles the tail after the authoritative branch
  by fallthrough as `write-settled`; a `switch` would give compiler-enforced
  exhaustiveness.

Acceptance criteria (binding):

- Route the registered loader missing-page case through `substituteMissingDaily`
- Remove the dead `write-started.ops` variant, require replay data, and eliminate the empty replay default
- Add tests that fail if local write tracking can erase a previously recorded replay
- Replace registration-order loader election with named loader kinds and explicit precedence
- Make outline transition handling compiler-exhaustive so new events cannot fall through as write settlement
- Preserve page/day loading, repair epochs, parent reads, and optimistic replay with focused race tests
- Document loader precedence and replay ownership in frontend/sync architecture

## Task 6: pkm-nvxh — Remove avoidable per-keystroke outline tree work

**Bean:** `pkm-nvxh`. **Review correctness/performance flags.** Runs after
Task 5 in the same worktree (both touch `outlineState.ts`); branch
`pkm-nvxh-outline-hot-paths` off the completed Task 5 branch.

- `web/src/components/EditableBlockTree.tsx` ~:297-302 — `focusInSubtree` is
  O(n·depth) per block per render, and the tree re-renders on every keystroke
  batch. Compute the focused block's ancestor chain once at the root and pass
  a constant-time per-block value down.
- `web/src/outline/outlineState.ts` ~:81-83 — `changed()` is a full-tree
  `JSON.stringify` compare on every transition (each keystroke batch, each
  remote batch). A `didChange` signal out of `applyOps` (`outline/tree.ts`)
  would remove the hidden per-keystroke cost.

Acceptance criteria (binding):

- Compute the focused block ancestor chain once at the tree root and pass or derive a constant-time subtree-focus value per rendered block
- Replace full-tree `JSON.stringify` comparison with an explicit change signal from operation application or an equally reliable structural result
- Preserve render decisions, focus navigation, no-op transition identity, optimistic updates, and remote batch behavior
- Add correctness tests plus a focused complexity/performance assertion that would catch reintroduction of repeated full-tree work
- Document any changed tree/applyOps contract

Notes: "no-op transition identity" means a transition that changes nothing must
keep returning the identical state object (referential equality) so React
skips the render — the change signal must be exactly as reliable as the
stringify compare it replaces, including ops that turn out to be no-ops
(e.g. setting text to its current value). The performance assertion should be
structural (e.g. a spy counting walks/serializations), not a timing test.

## Integration (controller-owned)

- Merge lanes into `main` sequentially with `--no-ff`, running
  `cd web && pnpm verify` (and server gates if anything server-side moved —
  nothing should) after each merge; resolve architecture-doc conflicts by hand.
- Final whole-branch review over the union of all six tasks before the last
  merge is declared done.
- Update the epic bean `pkm-wvvu` checklist; do not complete the epic (other
  children remain open).
