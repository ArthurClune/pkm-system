# Cmd-B / Cmd-I Bold & Italic Shortcuts — Design (pkm-kkpe)

Date: 2026-07-20
Status: approved by Arthur

## Goal

Cmd-B bolds, Cmd-I italicises, in the block editor. With a selection the
markers wrap it; with a bare caret an empty marker pair is inserted with the
caret in the middle. Both shortcuts toggle. Markers follow the app's Roam-style
grammar (`web/src/grammar/tokenize.ts`): `**` = bold, `__` = italic.

Alongside the feature, a keyboard-shortcut consistency audit was performed;
its conclusions and the small cleanups it motivates are part of this spec.

## Audit conclusions

In-editor shortcuts already have a single, correct architecture: the shell
(`EditableBlockTree.onKeyDown`) snapshots DOM/autocomplete state, the pure
policy `decideEditorKey` (`web/src/outline/keyboardPolicy.ts`) returns a typed
`KeyDecision`, pure text transforms live in `web/src/outline/keyEdits.ts`, and
one shell `switch` executes effects. Cmd-K already works this way via the
`key-edit` decision; Cmd-B/I reuse it unchanged. No shell changes.

Findings acted on:

1. **Modifier conventions are per-shortcut and undocumented.** Cmd-K is
   Meta-only; undo and todo-cycle accept Meta-or-Ctrl; Ctrl-O and
   Ctrl-Shift-D are Ctrl-only. Each is individually justified (emacs textarea
   bindings, macOS-reserved chords). A comment block in `keyboardPolicy.ts`
   will codify the convention: *letter-chord editing shortcuts are Meta-only
   (preserving emacs Ctrl bindings in textareas); shortcuts mirroring
   system-wide conventions (undo/redo) accept Meta or Ctrl.*
2. **Cmd-K does not exclude Shift.** The new shared branch requires
   `!shiftKey`, reserving Shift chords for future shortcuts. Deliberate small
   behaviour change: Cmd-Shift-K no longer wraps a link.

Findings explicitly left alone: the four global listeners (App.tsx daily-note
and sidebar toggles, SearchBar Cmd/Ctrl-U, UndoRedoKeys) are small, colocated
with their targets, and carry bespoke guards (`defaultPrevented`,
`isEditableTarget`); centralizing them buys nothing today. Block-selection
Cmd-C in EditableBlockTree is part of selection mode, not an editing chord.

## Design

### `keyEdits.ts` — new pure transform

```ts
export function toggleEmphasis(
  text: string, selStart: number, selEnd: number, marker: "**" | "__",
): TextSelection
```

Behaviour, in order:

- **Selection, markers just outside** (`**sel**` with `sel` selected):
  remove both markers, keep the stripped text selected.
- **Selection including the markers** (`**sel**` fully selected): strip
  them, keep the inner text selected.
- **Any other selection**: wrap as `marker + sel + marker`, keep the inner
  text selected (offsets shift by `marker.length`) — so a following Cmd-I
  stacks and a second Cmd-B un-toggles.
- **Bare caret between an empty pair** (`**|**`): delete the pair, caret
  where the pair was.
- **Bare caret otherwise**: insert `marker + marker`, caret in the middle.

Out of scope (add later if wanted): VS Code-style expansion where a bare
caret inside a non-empty emphasised word toggles that word; trimming
whitespace-padded selections (`** text **` may not tokenize as bold — the
user gets what they selected).

### `keyboardPolicy.ts` — table instead of a one-off branch

Replace the single Cmd-K `if` with:

```ts
const META_WRAP_EDITS: Record<string,
  (text: string, selStart: number, selEnd: number) => TextSelection> = {
  k: wrapLink,
  b: (t, s, e) => toggleEmphasis(t, s, e, "**"),
  i: (t, s, e) => toggleEmphasis(t, s, e, "__"),
};
```

One branch matches `metaKey && !ctrlKey && !altKey && !shiftKey` plus a table
key and returns `{ type: "key-edit", edit: ... }`. Future wraps (`~~`, `^^`)
become one-line table entries. The branch sits where the Cmd-K branch sits
today (after the read-only gate — all three mutate text).

### Error handling

None needed: transforms are total functions on (text, selStart, selEnd) and
the policy runs behind the existing read-only gate. Autocomplete-open state
already takes precedence earlier in the policy and is unaffected (B/I are
letter keys the popup ignores).

## Testing

TDD throughout.

- `keyEdits.test.ts` — `toggleEmphasis`: wrap keeps inner selected; unwrap
  for both selection shapes; empty-pair insert and delete; both markers;
  boundary caret positions (start/end of text).
- `keyboardPolicy.test.ts` — Cmd-B/Cmd-I produce `key-edit`; Ctrl/Alt/Shift
  variants fall through; read-only returns none; Cmd-K still works and now
  ignores Cmd-Shift-K.
- One Playwright e2e: Cmd-B on a selection in a real block produces bold
  rendering after blur (use `press`, not `keyboard type`; POST-created unique
  page, not today's journal).
