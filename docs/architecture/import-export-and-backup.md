# Import, export and backup

These batch jobs run beside the live server. `pkm.backup` takes the nightly
snapshot, `pkm.export` renders a database to markdown, and `pkm.importer`
builds a fresh database from a Roam EDN export. The two exports are also
HTTP downloads. The server is in [backend.md](backend.md), the schedule and
restore steps in [deploy/README.md](../../deploy/README.md#backups).

## Backup job

`python -m pkm.backup` takes an online SQLite `.backup()` from a read-only
connection into `backups/sqlite/`, so the live database is never opened for
writing. `rotation.py` prunes the snapshots. The job then runs the markdown
export from that same snapshot and git-commits it. Any failure exits
non-zero.

## Restore

`python -m pkm.backup.restore --data-dir DATA SNAPSHOT` is the one way a
snapshot goes back in place; `deploy/icloud_backup.py restore` calls it, and
[deploy/README.md § Restore](../../deploy/README.md#restore) has the steps.
**It always rotates `db_generation`.** The restored journal restarts from the
snapshot's `sqlite_sequence`, so it reuses seqs a device may already have
pulled past. The `since > latest` guard in `sync_changes` misses every cursor
the new timeline has overtaken, and only a new generation makes that device
rebootstrap ([sync-recovery.md § Rebootstrap
triggers](sync-recovery.md#rebootstrap-triggers)).

The snapshot is copied as bytes, then `init_db` and the rotation run on the
copy before it is renamed over the target. Opening the snapshot instead would
leave `-wal` and `-shm` beside it, since a read-only connection to a WAL-mode
file cannot remove them on close.

Both tools that swap a whole database file in, the restore and the importer,
run `db_swap.swap_refusal` on the target. SQLite replays a leftover WAL over
whatever file holds the name on the next open, so a file swapped in beside
one reads as the old database, or a mix of both.

| Sidecars beside the target | `swap_refusal` |
|---|---|
| none | passes |
| left by a crash or a closed read-only reader, such as the nightly backup | folds them by opening and closing the target read-write, then passes |
| held by an open connection | the fold's close leaves them, so it refuses: "Stop the server first" |

It never unlinks a sidecar, because a live writer's WAL holds commits the
file does not. An idle server holds no connection, so the check passes while
it runs; stopping the server is the operator's step.

## Markdown export

`export/writer.py::export_graph` renders pages to `export/pages/<title>.md` and
dailies to `export/journal/YYYY-MM-DD.md`. `markdown.py` resolves `((refs))`
one level deep and keeps `{{query: ...}}` macros as written. Unchanged files
are rewritten byte-identically, so a nightly git diff is minimal.
`/api/export.zip` runs the same `export_graph()` into a temp directory.

It calls `refs.extract()` once per block (`collect_block_ref_uids`), which is
one reason the scanner must stay linear ([backend.md § Ref
grammar](backend.md#ref-grammar)).

Page filenames and asset zip arcnames dedupe by `filenames.fs_dedupe_key`,
which compares names as APFS does (Unicode-normalised, case-folded). A key
weaker than the filesystem's silently overwrites a page; a stricter one only
adds a dedupe suffix. `test_filenames.py` checks the key against the real
filesystem.

Assets are mirrored incrementally. An existing destination is checked against
the `assets` row's size and sha256 before it is hardlinked into the new tree
(`assets_disk.asset_on_disk_needs_repair`, `assets_core.asset_needs_repair`).
A mismatch is re-copied from the live store, and the importer calls the same
check.

The export directory has one writer, so each run sweeps abandoned
`.export-staging-*` entries first, with no lock or age heuristic. Rendering
and asset copying happen in a fresh staging directory, then `_publish_dir`
swaps `pages/`, `journal/` and `assets/` in with one atomic rename each.

| Failure at | Leaves | Healed by |
|---|---|---|
| rendering, disk or asset copy | the last export, byte-identical | — |
| between two `_publish_dir` renames | a mixed old/new tree; old subtrees under `<name>.stale` | the next successful run |

Either way the exception stops the backup job before its git commit.

## Single-page export

`GET /api/export/page/{title}` (`routes_export.py`, `export/resolve.py`) is the
user's download, and it renders what a reader of the live page sees:

- `((refs))` resolve recursively and are inlined as plain text.
- `{{query: ...}}` and `{{[[query]]: ...}}` execute through the live
  `/api/query` path (`query_exec.parse_canonical_query`, `plan_sql`,
  `query_exec.execute_plan`) and render as results grouped by page.
- Depth caps match the UI: `BLOCK_REF_MAX_DEPTH` mirrors `BlockRef.tsx`'s
  `MAX_DEPTH`, and `QUERY_MAX_DEPTH` mirrors `QueryBlock.tsx`'s. Nothing checks
  that they agree.

`export/resolve.py` is pure over uid→text and expr→results maps. The route
fetches them breadth-first with a `visited` set, which stops the fetch of a
cyclic `((ref))` chain; the depth caps stop its render.

The depth caps do not bound output size: K refs a level over
`BLOCK_REF_MAX_DEPTH` levels is K to that power copies of the leaf. So
`render_page_resolved` holds one budget, shared by every block and every
recursion, with two limits:

| Limit | Charged | Why it exists |
|---|---|---|
| `EXPORT_MAX_CHARS` characters of body | each piece of text as it is appended | K to the depth copies of a leaf |
| call units, one per `CHARS_PER_CALL` characters of that bound | one per `resolve_text` or `render_query_result` call, plus one per `SCAN_CHARS_PER_UNIT` characters a `resolve_text` call scans | refs back to back over an empty leaf output nothing yet make that many calls |

Past either limit the renderer raises `ExportTooLarge`. The route answers 422
with the exception's message, which says which limit was passed. A page is
never truncated.

**Characters are charged as text is appended, never on the finished body.**
Expansion is built bottom-up, so a check on the result would come after the
whole exponential body was built.

The route's gather (`_gather_resolution_data`) charges the same limits through
one `GatherBudget` per export, so it refuses only what the renderer would.
The one exception is a query reached only through a ref inside a query
macro's body: the gather charges it, and the renderer never renders it.

## Importer (Roam EDN → fresh database)

`python -m pkm.importer.run export.edn --files <dir> --out <data-dir>` builds a
complete new database and swaps it in, so re-running is safe once the server
is stopped ([Restore](#restore) has the WAL refusal it shares). The stages
run in this order; everything before the temp database is Functional Core.

| Stage | Invariant |
|---|---|
| EDN parse (`edn.py`, `parse_export.py`) | Malformed input exits 2 with `error: malformed export at offset N: DETAIL`. The solidus escape `\/` stays invalid. `:create/time`, `:edit/time`, uids and sibling order survive, so every `((block ref))` resolves |
| Preflight (`preflight.py`) | Duplicate block uids, a block reached through two parents, and any uid failing `UID_RE` refuse the run, listing every offender before any output. A block past [`MAX_OUTLINE_DEPTH`](write-path.md#work-bounds-under-the-write-lock) refuses it too (`validate_export_depth`). No uid is re-minted, because every `((uid))` recognizer shares `UID_RE`'s bound |
| Title sanitization (`titles.py`) | Strips balanced `[[`/`]]` and `#` markers and rewrites refs. Collisions merge in source order, preferring an already-clean survivor |
| Refused titles (`sanitize_import_title`) | A refused page title skips its page (`SanitizedImport.skipped_pages`), and its blocks go to the recovery page. A refused ref becomes plain text (`unlink.unlink_stale_refs`): as a ref, the ops title check would refuse every edit to its block |
| Rows (`rows.py`, `mermaid_preservation.py`) | Asset URLs are rewritten and mermaid components fold into fences, except a component with an inbound `((uid))` into its subtree, which stays nested blocks |
| Orphan blocks (`rows.py`) | Every subtree unreachable from a page (`Export.orphan_blocks`, cycles included) is attached intact under `RECOVERY_PAGE_TITLE`. The first placement of a block stands, and later claims are listed (`Export.dropped_claims`) |
| Text limits | A block past a [text limit](write-path.md#work-bounds-under-the-write-lock) refuses the run, naming the block and its sanitised page (`validate_row_text_limits`). It judges rows, since asset-URL rewriting and mermaid folding change the text |
| Write `pkm.sqlite3.tmp`, copy assets | The [export's verify-then-copy check](#markdown-export), rewriting a mismatched destination atomically. It runs after the row `commit()`, which the title migration needs |
| Title migration | The operator route's `audit_title_migration()` / `apply_title_migration()` run on the temp database, so `plain_space_title_canonicalization` arrives active. A blocker, or a rewrite past a text limit (`RewriteTextLimitError`), exits 2 |
| Publish | `import-report.txt.tmp` is written, then `os.replace` moves in the database, then the report |

| Failure at | Leaves | Healed by |
|---|---|---|
| any stage before the first `os.replace`, or a WAL another connection holds | the published database and report untouched | — (the next run deletes `pkm.sqlite3.tmp` first) |
| between the database and report replaces | the new database beside the old report | the next successful run |
