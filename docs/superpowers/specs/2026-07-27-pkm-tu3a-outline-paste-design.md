# Hierarchy-Preserving Outline Paste — Design (pkm-tu3a)

Date: 2026-07-27
Status: designed during an autonomous session; decisions recorded inline

## Goal

Pasting multi-line text into a block turns each line into its own block, and
outline indentation in the clipboard (tabs, spaces, markdown bullets) becomes
real parent/child structure anchored at the paste location. Today a
multi-line paste falls through to the textarea and lands as one block with
embedded newlines.

Copying a multi-block selection also gains tab indentation so that
copy → paste round-trips hierarchy inside the app. (`selectionText`
currently joins the selected blocks flat with `\n`, so without this the
paste feature could never round-trip our own copies. Scope decision made
autonomously; the change is a few lines.)

## Current behaviour

- `BlockInput.onPaste` (`EditableBlockTree.tsx:685`) only intercepts file
  pastes; text pastes take the native textarea path and become one draft
  containing newlines.
- `selectionText` (`blockSelection.ts:39`) copies a selection as flat
  newline-joined text.
- Structural gestures plan complete op batches in the Functional Core
  (`edits.ts`) and dispatch through `useOutline`'s `run()`, which flushes the
  pending draft, applies ops optimistically, enqueues one server batch, and
  records one undo entry. pkm-0ovd's selection indentation is the model.

## Clipboard interpretation rules

Normalization and parsing are pure and live in a new Functional Core module.

1. Normalize `\r\n` and `\r` to `\n`.
2. Lines that are entirely whitespace are dropped (they separate content but
   never create empty blocks).
3. **Interception test:** a paste is an outline paste when it parses to
   more than one node (multiple roots, or one root with children).
   Anything else — single-line, blank-only, or a single content line even
   with a trailing newline — keeps the native splice behaviour, because a
   tree-direct text update on the focused block would fight the
   dirty-draft adoption model. File pastes keep the existing `onFiles`
   path, checked first.
4. **Indent measurement:** each line's leading whitespace is measured as a
   column width with tabs expanded to 4 columns. Depth is assigned with an
   indent stack seeded by the first non-blank line's width (a uniformly
   indented clipboard still starts at depth 0). Widths are compared
   ordinally, so 2-space, 4-space, and tab indents all work without
   configuring a unit:
   - width greater than the stack top → one level deeper (push). A jump of
     any size is exactly one level — malformed over-indentation clamps.
   - width equal to a width on the stack → pop back to that level, sibling.
   - width between two stack levels (malformed) → pop until the top is ≤
     the width, treat as a sibling at that level.
5. **Bullet stripping:** if every non-blank line starts (after its indent)
   with `- `, `* `, or `+ `, that marker is stripped from every line. A
   consistent markdown list pastes as clean blocks, while prose that merely
   contains a leading dash on one line is left verbatim. Numbered lists are
   out of scope and paste literally.
6. All other content is verbatim — markdown, `[[refs]]`, TODO markers stay
   untouched; refs materialize as usual when the ops apply server-side.

## Anchor semantics

The paste targets the focused block (`uid`) with the textarea's live
`selStart`/`selEnd`. `run()` flushes the pending draft first, so the tree the
planner sees already contains the draft text the user was looking at.

- The **first root's text splices into the target block** at
  `[selStart, selEnd)`, replacing any selected text (matches the mental
  model "the first line is typed at the caret").
- The **first root's children become the target block's first children**,
  ahead of any existing children (they sit directly under the line they
  were pasted with). If the target block has children and is collapsed, it
  is expanded (`set_collapsed`) so the pasted content is visible —
  mirroring `indentBlock`'s destination-expansion rule.
- **Remaining roots become siblings inserted immediately after the target
  block**, in clipboard order, each carrying its subtree.
- **Focus** lands at the end of the text of the last block created in
  document order. (A single root with no children is no longer intercepted
  at all — see rule 3 — so the planner is never invoked for that case in
  practice; focus for any paste the shell does dispatch is always the last
  created block.)
- Missing target uid, empty parse, or read-only outline → no-op (no ops,
  native behaviour not restored retroactively; the shell only intercepts
  when the parse is non-empty and the outline is editable).

## Copy-side change

`selectionText` indents each selected visible block with one tab per depth
level relative to the shallowest selected block. Visible-only semantics are
unchanged (collapsed descendants still don't copy). Tabs round-trip through
rule 4 above.

## Architecture

### Functional Core: `web/src/outline/paste.ts` (new)

```ts
export interface PastedNode { text: string; children: PastedNode[] }

/** Rules 1–6: normalized clipboard text → forest. */
export function parseOutlineForest(text: string): PastedNode[]

/** True when onPaste should intercept (parses to more than one node). */
export function isOutlinePaste(text: string): boolean

/** Forest + anchor → EditResult (update_text splice, create ops for every
 * pasted node in document order, optional set_collapsed, focus target).
 * newUid is injected so tests stay deterministic (same as splitBlock). */
export function planOutlinePaste(
  blocks: BlockNode[], pageTitle: string, uid: string,
  selStart: number, selEnd: number, text: string,
  newUid: () => string,
): EditResult
```

The planner derives every `order_idx` from the tree (never array positions)
and generates ops in an order that `applyOps` and the server's sequential
batch application both accept: parent creates precede child creates; sibling
creates use insert-before semantics consistent with `splitBlock`/
`groupMoveOps`. This is deliberately a clipboard-to-create-ops planner, not
a generic tree diff (bean note; same rejection as pkm-0ovd).

### Functional Core: `web/src/outline/blockSelection.ts`

`selectionText` gains relative-depth tab indentation.

### Imperative Shell: `web/src/components/EditableBlockTree.tsx`

`BlockInput.onPaste` keeps the file branch, then reads
`clipboardData.getData("text/plain")`; when `isOutlinePaste(text)` and not
read-only it calls `preventDefault()` and dispatches a new
`OutlineHandlers.onPasteOutline(uid, selStart, selEnd, text)`.

### Imperative Shell: `web/src/outline/useOutline.ts`

`onPasteOutline` runs the planner through the existing `run()` pipeline:
one flushed base tree, one optimistic apply, one enqueued batch, one undo
entry, focus from the planner.

### Server and data model

No changes. Creates/updates ride the existing batch semantics; batches are
transactional so a rejected op rolls the whole paste back.

## Out of scope

- Paste while a multi-block selection is active (tree owns focus; no
  textarea receives the event).
- Numbered-list markers, HTML clipboard flavors, and OPML.
- `((` block-ref expansion of pasted refs (existing behaviour unchanged).

## Failure handling

The planner returns no ops when the target uid is missing or the parse is
empty. The shell never intercepts single-line or file pastes, so degraded
clipboards keep today's behaviour. Malformed indentation never throws — the
stack rules above give every line a home.

## Testing

Red-green TDD throughout.

- **Parser unit tests** (`paste.test.ts`): tabs, 2-space, 4-space, mixed
  tab/space, bullets (consistent and inconsistent), numbered lines stay
  literal, blank lines, CRLF, over-indent jump clamping, dedent to
  never-seen width, single line, blank-only.
- **Planner unit tests**: splice into empty block, mid-text caret with a
  selection replaced, first-root children prepended before existing
  children, collapsed target expanded, sibling roots after target, exact op
  batches (uids injected), focus target, missing uid no-op.
- **Copy unit tests** (`blockSelection.test.ts`): relative-depth tabs.
- **Component tests** (`EditableBlockTree.test.tsx`): multi-line text paste
  dispatches `onPasteOutline` and prevents default; single-line paste does
  not; file paste still routes to `onFiles`; read-only does not dispatch.
- **Hook tests** (`useOutline` tests): enqueued batch + focus + single undo
  entry.
- **E2E** (Playwright): on a POST-created unique page (never today's
  journal), dispatch a `paste` event with a `DataTransfer` carrying an
  indented outline; assert the rendered hierarchy; then select-all-blocks,
  copy (patched `writeText` → `window.__copied`), paste into a fresh page
  and assert the round-trip. `pnpm build` first — e2e serves `web/dist`.

Full verification: `cd web && pnpm verify` (typecheck, unit coverage,
Playwright), plus server suite untouched but run once before merge.
