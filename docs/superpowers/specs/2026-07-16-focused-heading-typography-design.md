# Focused Heading Typography Design

**Date:** 2026-07-16

**Bean:** pkm-ofec

## Goal

Make the existing `Ctrl-Alt-0/1/2/3` heading shortcuts visibly effective while a
block is being edited. A focused heading must retain the same font size and weight
as its unfocused H1, H2, or H3 presentation. `Ctrl-Alt-0` must restore ordinary
body typography.

## Root Cause

The shortcut path already recognizes physical digit keys, dispatches
`set_heading`, applies the operation optimistically, and persists it. Existing
handler-wiring tests verify that path. The apparent failure is presentational:
`EditableBlock` replaces the unfocused `h1.block-text`, `h2.block-text`, or
`h3.block-text` element with `BlockInput` while focused, and `.block-input` only
inherits the ordinary row typography. The metadata changes, but its visual result
is hidden until the editor blurs.

## Design

Keep the shortcut policy and operation path unchanged. When rendering `BlockInput`,
derive a heading-level class from the live `node.heading` value and apply it to the
focused textarea. Share the existing heading font-size and font-weight declarations
between unfocused block text and the corresponding focused heading class.

Because `set_heading` updates the outline optimistically, the focused component
receives the new `node.heading` immediately. React updates the heading class without
remounting the textarea, so the draft, selection, caret, autocomplete state, focus,
and raw markup remain intact. Clearing the heading removes the heading class and
restores normal inherited typography.

The focus background remains unchanged. Focused blocks continue to show raw source
rather than rendered inline markup.

## Architecture and Compatibility

This is a presentation-only change in the existing imperative React shell and CSS.
It does not add business logic, operations, schema fields, API changes, or server
work. The existing functional keyboard policy remains the authority for the exact
`Ctrl-Alt-0/1/2/3` chord and read-only behavior.

No new error path is introduced. Unknown or null heading values use ordinary body
typography, matching current rendering behavior.

## Testing

Component tests will cover focused H1, H2, and H3 class selection and plain-text
fallback. A shortcut interaction test will verify that applying `Ctrl-Alt-1/2/3`
updates the focused heading styling immediately and that `Ctrl-Alt-0` removes it,
without changing draft text. CSS tests will pin the focused and unfocused heading
selectors to the same font size and weight.

The normal web verification command remains the release gate.

## Out of Scope

- Changing the existing `Ctrl-Alt-0/1/2/3` bindings.
- Changing slash-command toggle behavior.
- Rendering formatted inline markup inside the focused textarea.
- Changing heading sizes, weights, or the focus background.
