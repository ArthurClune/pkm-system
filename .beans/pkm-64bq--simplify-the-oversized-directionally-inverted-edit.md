---
# pkm-64bq
title: Simplify the oversized, directionally inverted editor boundary
status: completed
type: task
created_at: 2026-08-01T13:21:21Z
updated_at: 2026-08-01T14:20:00Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 12.

**References:** web/src/outline/useOutline.ts:10,38-52; web/src/components/EditableBlockTree.tsx:36-91,147-201,390-801

The outline engine imports its roughly 30-callback command interface from a UI component. EditableBlockTree defines the engine's port while BlockInput combines draft adoption, IME state, autocomplete, uploads, date picking, navigation, paste arming, and keyboard execution. Selection keyboard policy also remains ad hoc in the component despite the separate keyboard-policy core.

**Direction:** Move the editor command/port type into outline/, consider a discriminated command dispatcher plus a small set of imperative capabilities, extract the input shell/controller, and move selection decisions into the shared keyboard policy.

- [x] Define the intended editor dependency direction and command boundary
- [x] Extract cohesive input/session responsibilities without creating speculative abstractions
- [x] Move remaining keyboard decisions into the functional core

## Summary of Changes

Behaviour-preserving refactor in three commits; no test assertion changed, and
the nine new tests are for logic that moved into the functional core.

**1. The command boundary (`web/src/outline/handlers.ts`, new).** `OutlineHandlers`
moved verbatim out of `EditableBlockTree.tsx`. The engine now declares the
contract it implements, so the dependency runs UI -> engine; `useOutline` no
longer imports a type from a component. Type-only file, so it takes an FCIS
exemption (alongside `api/ops.ts`) rather than a pattern header.

Deliberately NOT a discriminated command union + dispatcher. Every member is
already a distinct, named, individually-typed operation, so a union would add a
second name and a switch case per member while removing none — the direction
was the problem, not the shape. Recorded in the file's own header comment and
in `docs/architecture/frontend.md`.

**2. The input shell (`components/BlockInput.tsx` + `outline/useBlockDraft.ts`,
both new).** BlockInput was 420 lines inside the tree file. Split:

- `useBlockDraft` (Imperative Shell hook) owns the draft session: the textarea
  value and element ref, dirty tracking, IME composition, adoption of committed
  text over a clean draft, and every caret placement following a programmatic
  value change. It knows nothing about autocomplete or slash commands —
  callers pass the new text and whether its flush is held.
- `BlockInput.tsx` is the input surface: it wires the draft, the shared
  autocomplete controller (pkm-noow) and the keyboard policy together and
  executes their decisions, plus the popup / date picker / paste / drop
  surfaces that exist only while a block is focused.
- `EditableBlockTree.tsx` keeps the read-side render, the bullet menu, the
  tree-owned upload input and the selection keyboard: 810 -> 322 lines.

The `onDraftChange` call arity is unchanged on purpose (two args when the flush
is not held) — tests assert it exactly.

**3. The selection keyboard (`outline/keyboardPolicy.ts`).** The last ad-hoc
keyboard logic in a component: an if/else ladder mixing modifier matching, the
read-only gate and handler calls. Now `decideSelectionKey`, pure and TDD'd
(nine cases written failing first), with the component executing decisions the
same way BlockInput does for `decideEditorKey`. Identical branch for branch,
including the subtlety the ladder only encoded implicitly: a read-only mutation
key resolves to `"none"` and is left UNCANCELLED, while extend/copy/clear stay
read-only-safe (pkm-rckh).

`docs/architecture/frontend.md` updated: the module map (the new port and hook,
components count), a new "which way the editor's dependencies point" paragraph
recording the port's home and the no-dispatcher decision, and the selection
keyboard's description with its uncancelled-`"none"` invariant.

Verified: `pnpm test:unit` (1776 passed), `pnpm typecheck`, `pnpm lint`,
`pnpm check:fcis`, `pnpm test:coverage` (97.47% statements, thresholds met).
