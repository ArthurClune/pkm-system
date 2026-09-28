# Conflicts in the daily note — design

Bean: pkm-3g4n. Approved in conversation 2026-09-28.

## Why

On 2026-09-28 an iPad replayed 13 queued edits of a block the server never
had. Each became its own `[[conflict]] (original block deleted) …` block on
the daily note — six near-identical prefixes of the same text — and none said
which page the text came from ("AI Agent Security"). Meanwhile two-edit
conflicts on live blocks land as siblings on the block's own page, so there is
no single place to review conflicts.

Goal: every conflict is reviewable in one place, today's daily note, grouped
per block, and always names the page so Arthur can decide what to do.

Non-goals: changing who wins (incoming still wins, last-write-wins), the
legacy no-hash path, rename replay, or how clients receive the result (the
ordinary changes feed).

## Contract

`UpdateTextOp` (`server/src/pkm/contracts/ops.py`) gains an optional
`page_title: str | None = None`. It only labels a conflict; it never changes
where or whether the edit applies. Clients that omit it keep working.

| Producer | Source of `page_title` |
|---|---|
| Web main thread | `stampBaseTextHashes` (`web/src/outline/baseTextHash.ts`) already receives the planning page's `pageTitle`; it stamps `page_title` on every `update_text` whose block it finds in that tree, alongside `base_text_hash`. Undo history keeps recording unstamped ops; `undoManager.dispatch` stamps at replay time, as it does for the hash. |
| Web worker | `enqueueBatch` (`web/src/replica/queue.ts`) fills `page_title` from the replica only when it also fills `base_text_hash` itself (the block's page title from `pages`); an op that arrives already hashed is persisted unchanged, so the durable row and the fallback-lane copy stay byte-identical (as shipped; see `sync-and-offline.md`). |
| CLI / MCP | `plan_update` / the guarded update path (`server/src/pkm/planning.py`) passes the fetched block's page title. |

`openapi.json` and the generated web types are regenerated.

## Placement and shape

Every conflict goes to today's daily page (`title_for_date(date.today())`,
server-local, as now). Nothing is inserted on the block's own page.

| Conflict | Header block (top level of the daily page) | Child appended under it |
|---|---|---|
| `update_text` with a hash, block exists, text diverged (check 5) | `[[conflict]] [[<block's page>]] — overwritten by ((<uid>))` | the overwritten server text, verbatim |
| `update_text` with a hash, block missing | `[[conflict]] [[<page_title>]] — edit to a block the server no longer has` | the incoming text, verbatim |
| same, no `page_title` | `[[conflict]] (page unknown) — edit to a block the server no longer has` | the incoming text |

- Children are verbatim, so a lost `TODO …` becomes a live TODO in the
  daily note and a lost `Key:: value` a live attribute of the header block.
  Accepted for now (Arthur, 2026-09-28: "keep them verbatim for now");
  neutralising them (e.g. a `was:` prefix) is the fallback if the
  duplicates prove noisy.
- Children carry no `[[conflict]]` prefix; the header's tag keeps every entry
  findable through search and the `conflict` page's backlinks, and the
  `[[Page]]` link lists it in that page's linked references.
- In the live-block case the page comes from the server's own row, not the
  hint.
- `ReindexRefs` runs for each inserted block, so refs and `block_refs` stay
  right.

## Grouping

A server-only table in `SERVER_DDL` (never `BASE_DDL`, like `block_rewrites`):

```sql
CREATE TABLE IF NOT EXISTS conflict_headers(
  target_uid TEXT NOT NULL,
  day        TEXT NOT NULL,   -- the daily page's title
  header_uid TEXT NOT NULL,
  PRIMARY KEY (target_uid, day)
);
```

On a conflict for block `U`:

1. Look up `(U, today)`. If a row exists and `header_uid` is still a block on
   today's daily page, append the child as its last child.
2. Otherwise insert a new header at the daily page's next top-level index,
   insert the child under it, and upsert the row.
3. Delete rows whose `day` is not today (keeps the table to today's
   conflicts).

The lookup is context assembly in `ops_apply.py`'s `_context_for` (shell);
the choice between append and create, and the texts, are pure planning in
`ops_core.plan_op` over new `OpContext` fields (existing header uid and its
next child index; the page title to show). The row upsert and the prune are
a new effect (`RecordConflictHeader`) executed like the others.
`apply_batch` reads each op's context after the previous op's effects have
executed, so a second conflict for the same block in one batch sees the
first one's row and groups under it.

## Unchanged

- Incoming text wins; `replay_title_rewrites` runs first.
- No `base_text_hash` -> plain LWW (check 3), and a missing block without a
  hash still raises "block not found".
- Structural ops on missing blocks still 400 — out of scope, bean pkm-foap.

## Testing

- `test_ops_core.py`: each table row; append vs create; header deleted by the
  user -> fresh header; day rollover -> fresh header; `(page unknown)`.
- `test_ops_endpoint.py` / `test_ops_apply.py`: end to end through
  `POST /api/ops`, including two conflicts for one block in one batch and in
  two batches; replayed batch id does not duplicate; refs indexed; changes
  journal rows present. Update the existing assertions that expect sibling
  copies and the `(original block deleted)` text.
- Web: `baseTextHash.test.ts` stamps `page_title`; undo replay stamps fresh;
  `queue.test.ts` worker fills it when absent.
- CLI: `plan_update` emits `page_title`.
- Parity: `shim_parity` / regen checklist if the op shape is covered there.

## Docs

`backend.md` (write path, conflict rules), `sync-and-offline.md` (offline
editing and reconnect), `overview.md`, `docs/design.md` rationale line, the
CLI help text in `cli/main.py`, MCP tool descriptions; grep every
`[[conflict]]` mention for the old sibling / `(original block deleted)`
wording.
