# Uploaded files each go on their own bullet

## Intent

Uploading several images at once (`/upload`, paste, or a drop onto the
block being edited) splices every asset link into the current block,
space-joined, so they sit on one line. Images inside a line of text
don't work well anyway. Each upload should be its own bullet.

## Behaviour

- Every upload through `onFiles` becomes a new block, a sibling straight
  after the current block (after its subtree), in upload order, all at the
  current block's depth.
- If the current block is empty, the first upload fills it instead and the
  rest follow as siblings.
- A single upload follows the same rule: into the block if it is empty,
  else a new sibling after it.
- The current block's text and caret are never touched when it has text.
  Focus never moves into a new asset block (it would show raw markdown
  instead of the rendered asset). An empty block that gets filled keeps
  today's focus rule: the caret goes after the markdown only if that block
  still owns focus (paste, drop), not after `/upload`, which has blurred it.
- The whole upload is one `run()`: one batch, one undo entry, fresh assets
  released on undo as today.
- Failed uploads keep today's banner; the successful ones still land.

## Non-goals

- Drops between blocks (`onDropFiles`) already make one block per file;
  unchanged.
- `/goodlinks` and local-file links still splice inline.

## Approaches

1. **(chosen)** A pure planner beside `planFileDropBlocks` in
   `outline/fileDrop.ts`: given the tree, the current block and the upload
   texts, return the ops (an `update_text` when the block is empty, plus
   `create`s after it). `onFiles` calls it inside `run()`.
2. Route these uploads through `onDropFiles` with a target computed from
   the block. Rejected: it has no "fill the empty block" case and reports
   errors in drop wording.

## Calls left to the builder (marked as Claude's)

- PDFs uploaded through `onFiles` get the same treatment as images: they
  render as blocks too.
- "Empty" means the block text is `""` (after `/upload` removes its own
  trigger text) — whitespace-only counts as empty as well.
- If the current block is gone when the uploads finish, the blocks go to
  the end of the page, as the drop path's fallback does.
