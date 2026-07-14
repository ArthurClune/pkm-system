# Block Presentation Controls Design

**Date:** 2026-07-14

**Beans:** pkm-zyd3, pkm-oi5d, pkm-93w9

## Goal

Add three related block-presentation features: persistent numbered subtree views,
heading keyboard/context-menu controls, and quote rendering for blocks whose
stored text starts with the exact prefix `> `.

## Existing Architecture

The editor follows a functional-core/imperative-shell split. Pure edit functions
produce block operations and optimistic trees; `useOutline` queues operations and
applies websocket updates; the server validates and persists the same operations.
The browser's SQLite replica applies the wire operations locally and rebuilds when
the generated base-schema hash changes. Both editable and read-only outlines render
`BlockNode` trees and inline tokens.

Heading data and the `set_heading` operation already cross every layer. The new
view mode will follow that path. Quote presentation is derived entirely from block
text and needs no schema or operation.

## Numbered Subtree Views

### Data model

Add nullable `blocks.view_type` metadata with the allowed explicit values
`"numbered"` and `"document"`. `null` means "inherit the surrounding effective
mode"; at the page root, inheritance resolves to document mode. This third storage
state is necessary so a numbered ancestor can affect ordinary descendants while an
explicit document choice creates a nested boundary.

Add `view_type` to create/read/snapshot/change-feed payloads and define a
`set_view_type` block operation. The operation accepts only `"numbered"` or
`"document"`, updates one block, touches its page, broadcasts unchanged through the
normal websocket path, and applies optimistically in both the in-memory outline and
offline replica.

Fresh databases include the column in `BASE_DDL`. Existing server databases are
upgraded by an idempotent migration that inspects `PRAGMA table_info(blocks)` and
runs `ALTER TABLE blocks ADD COLUMN view_type TEXT CHECK (...)` only when absent.
Client replicas already compare the generated schema hash and rebootstrap on a
mismatch, so they do not need an in-place column migration.

### Import behavior

The Roam parser consumes `:children/view-type`. `:numbered` maps to `"numbered"`
and `:document` maps to `"document"`; absent or unknown values map to `null`.
Importing never rewrites block text or tree structure.

### Effective-mode rendering

A block's explicit `view_type` controls the markers of its descendants, not its own
marker. This matches Roam's children-view metadata. Rendering carries an effective
mode down the tree:

1. A node is rendered using the mode inherited from its parent.
2. Its children inherit `node.view_type` when explicit, otherwise the node's
   inherited mode.
3. The page root starts in document mode.

In numbered mode, each sibling container resets a CSS counter and each visible
child receives its own `1.`, `2.`, ... marker. Nested sibling containers therefore
number independently. Document mode uses the existing bullets. Collapse state only
controls visibility and is not changed by switching modes.

The menu reports the effective mode that will apply to the selected block's
children. Choosing either option stores an explicit boundary on that block.

## Heading Controls

While a block textarea has focus, exact `Ctrl-Alt-0` through `Ctrl-Alt-3` key
combinations dispatch the existing `set_heading` operation. `0` maps to `null` and
`1`-`3` map to their numeric heading levels. The handler prevents the browser's
default action but does not change the draft text. Because newly created and
imported blocks use the same focused textarea, no separate path is required.

The block menu shows a heading group containing Plain text, Heading 1, Heading 2,
and Heading 3. The current value is checked. Menu actions call `onSetHeading`, so
they use the same flush-before-command, optimistic update, persistence, and remote
update behavior as slash commands.

## Block Menu Behavior

Extend `BlockMenuItem` with optional checked, disabled, and separator metadata.
Checked choices use `role="menuitemradio"` and `aria-checked`; ordinary actions
retain `role="menuitem"`. The menu renders the copy action, heading choices, and
view choices in labelled visual groups. Mutating choices remain visible but disabled
in a read-only outline, while copying stays available.

Opening a menu records enough tree context to calculate the selected node's current
heading and effective child-view mode. Picking an enabled item performs its action
and closes the menu. Disabled items perform no action.

## Quote Rendering

Add a pure helper that returns `text.slice(2)` only when `text.startsWith("> ")`;
otherwise it reports no quote. Both read-only blocks and unfocused editable blocks
use it before tokenization. Quoted content keeps the same heading element selection,
inline tokenizer, todo interaction, links, page references, block references,
embeds, and other inline segments, with a `quote-block` class adding the visual
border, indentation, and muted foreground.

The focused textarea always receives the full stored source, including `> `.
Therefore editing and syncing round-trip the source unchanged. Once an applied edit
adds or removes the exact prefix, the ordinary optimistic tree re-render immediately
adds or removes quote presentation. A greater-than sign elsewhere, bare `>`, and
prefixes without a following space are ordinary text.

## Error Handling and Compatibility

- Pydantic rejects unsupported `view_type` operation values before application.
- SQLite constrains persisted explicit values.
- Applying `set_view_type` to an unknown block follows the existing block-not-found
  operation error path.
- Unknown imported Roam view metadata is preserved in import statistics but does not
  invent an unsupported mode.
- Existing blocks migrate with `null`, which resolves to the current document view.
- Quote recognition is presentation-only and cannot corrupt stored text.

## Testing

Server tests cover fresh and existing-schema migration, parser/row mapping,
`set_view_type` validation/planning/application, page reads, snapshots/change feeds,
and generated OpenAPI/schema artifacts. Replica tests cover snapshot storage, local
operation persistence, local page-tree reads, and queued optimistic operations.

Web functional-core tests cover local and remote `set_view_type` tree application,
explicit document boundaries, and unchanged tree/text/collapse data. Component tests
cover all four heading shortcuts, menu actions and checked states, read-only disabled
states, nested numbering with per-level resets, reverting to document mode, imported
initial state, quote prefix recognition/removal, non-prefix greater-than characters,
and inline content inside quotes. Existing full server and web verification commands
remain the release gate.

## Out of Scope

- Additional Roam child view types such as table or kanban.
- Markdown blockquote parsing beyond the exact leading `> ` prefix.
- Changing heading slash-command behavior.
- Persisting any visual preference outside the block operation/sync model.
