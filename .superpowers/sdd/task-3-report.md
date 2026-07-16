# Task 3 Report: Editable outline integration and raw editing fallback

## Implemented behavior
- `EditableBlockTree` now renders a valid Roam table macro as a semantic `<RoamTable>` while the block is unfocused.
- Clicking the rendered table focuses the macro block at the end of `{{[[table]]}}` via the existing block click handler.
- Once focused, the semantic table disappears and the existing raw editor/outline source view appears instead.
- Focused valid tables reveal their source row blocks even if the imported macro was `collapsed: true`.
- Malformed/non-table macros still fall back to ordinary editable outline behavior and ordinary collapse rules.
- The chevron is hidden/disabled only in rendered-table display mode so there is no misleading collapse control while the semantic table is shown.

## Files changed
- `web/src/components/EditableBlockTree.tsx`
- `web/src/components/EditableBlockTree.test.tsx`

## RED evidence
Command:
```bash
cd web && pnpm exec vitest run src/components/EditableBlockTree.test.tsx -t "a rendered Roam table focuses its macro"
```
Output summary:
- `1 failed | 64 skipped`
- Failure: `Unable to find an accessible element with the role "table"`
- Cause matched the brief: editable tree had no semantic table yet.

## GREEN evidence
Command:
```bash
cd web && pnpm exec vitest run src/components/EditableBlockTree.test.tsx \
  src/components/BlockTree.test.tsx src/components/roamTable.test.ts
```
Output summary:
- `3 passed`
- `79 passed (79)`
- Exit status 0

## Commit and push
Commands run:
```bash
git add web/src/components/EditableBlockTree.tsx \
  web/src/components/EditableBlockTree.test.tsx
git commit -m "feat(web): edit rendered Roam table sources (pkm-kbv5)"
git push
```
Result:
- Commit: `b497892 feat(web): edit rendered Roam table sources (pkm-kbv5)`
- Push: succeeded to `origin/fix/roam-table-import`

## Self-review
- Focused vs unfocused: verified by the new regression test; unfocused shows the semantic table, focused shows the raw textarea.
- Imported collapsed tables: valid collapsed imports now surface as tables when unfocused and reveal descendants when focused.
- Malformed fallback: still handled by `roamTableRows(node) === null`, so malformed trees keep normal outline/collapse behavior.
- Click focus: table clicks bubble through the existing `Tag` click handler and call `onFocusBlock(node.uid, node.text.length)`.
- Chevron/descendant behavior: rendered-table mode hides the chevron; focused valid tables reveal descendants regardless of imported collapse; non-table/malformed blocks still obey collapse.
- Test quality: added one focused regression that exercises the full intended interaction, while existing `BlockTree` and `roamTableRows` suites continue covering semantic rendering and malformed parsing.
- YAGNI: no slash-command work, no bean/plan edits, no unrelated refactors, no Task 4/5 changes.

## Concerns
- None.

## Descendant-focus review fix

### Files changed
- `web/src/components/EditableBlockTree.tsx`
- `web/src/components/EditableBlockTree.test.tsx`

### RED evidence
Command:
```bash
cd web && pnpm exec vitest run src/components/EditableBlockTree.test.tsx -t "a rendered Roam table stays in raw mode when focus moves to a revealed descendant"
```
Output summary:
- `1 failed | 65 skipped`
- Failure: `expected <table class="roam-table">…(2)</table> to be null`
- Cause matched the review finding: moving focus to descendant `row-2` remounted the semantic table and hid the editable subtree.

### GREEN evidence
Command:
```bash
cd web && pnpm exec vitest run src/components/EditableBlockTree.test.tsx src/components/BlockTree.test.tsx src/components/roamTable.test.ts
```
Output summary:
- `3 passed`
- `80 passed (80)`
- Exit status 0

### Commit and push
- Commit: `fix(web): keep raw Roam table mode while editing descendants (pkm-kbv5)`
- Push: succeeded to `origin/fix/roam-table-import`

### Concerns
- None.
