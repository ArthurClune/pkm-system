# Contract: sync and offline

How the web client applies the changes feed and stamps its conflict hashes,
case by case. The sync property (`web/src/props/sync/`) is written from this
file and never from the code: `conflictNoise.ts` from [Conflicts at push
time](#conflicts-at-push-time), and `sync.prop.ts` draws feed windows small
enough to reach [Block tombstones](#block-tombstones). A change in behaviour
edits the row here and the model together. Each section's principle, and why
it holds, is in [sync-and-offline.md](../sync-and-offline.md) under the same
section name; a reason that belongs to one row sits in that row.

## Block tombstones

A block tombstone cascades the replica's local subtree.

| Window | Block tombstones |
|---|---|
| Short of the head | Recorded in `deferred_block_tombstones` with the cursor written in the same transaction. A block a later window ships live leaves the record |
| At the head | The recorded ones and its own apply, after its upserts; the record clears. A record whose cursor is not the current one is void |
| Snapshot | `applySnapshot` clears the record |

Between windows a deleted block stays editable, and an edit to it lands as a
conflict entry.

## Conflicts at push time

The client stamps `base_text_hash`, `base_subtree_hash` and `page_title`;
the server resolves the conflict ([write-path.md § Conflicts](../write-path.md#conflicts)).

| Batch | Its hashes |
|---|---|
| an editor batch | stamped while the editor builds it (`outline/baseTextHash.ts`, whose header says what the worker fills), against the tree it was planned from, so op N leaves the text op N+1's hash matches |
| an undo history entry | recorded unstamped; `undoManager.dispatch` stamps at replay. An entry-time hash is stale and lands a spurious conflict |
| an editor flush | taken over the text the user typed over ([contracts/frontend-editor.md § Drafts and commit points](frontend-editor.md#drafts-and-commit-points)), so of two concurrent edits from one base the later wins and the earlier becomes the conflict copy |
