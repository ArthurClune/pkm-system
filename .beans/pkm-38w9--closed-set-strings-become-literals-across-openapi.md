---
# pkm-38w9
title: Closed-set strings become Literals across OpenAPI; tombstone dispatch stops defaulting to sidebar delete
status: todo
type: task
priority: normal
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T07:44:38Z
parent: pkm-7uxw
---

Strings that only ever hold a fixed set of values are typed as open `str`/`string`. A pydantic `Literal` reaches OpenAPI as an `enum`, so the generated web types become unions with no extra work. `ViewType` (`server/src/pkm/contracts/ops.py:21`) and `SkipReason` (`contracts/responses.py:458`) already do this.

This bean also fixes one latent bug that a type alone can't close (the tombstone dispatch).

## Literals

| name | values | where | 
|---|---|---|
| `RefKind` | link, tag, attribute | Py `refs.py:93`, `contracts/responses.py:321` (`SyncRef.kind`), `title_migration` `InventoryRef.kind`, SQLite CHECK `schema.py:47`; web already has it at `grammar/refs.ts:10`, plus an inline copy at `replica/refs.ts:14` |
| `EntityKind` | block, page, sidebar | SQLite CHECK `schema.py:139`; `contracts/responses.py:352` (`SyncTombstone.kind`); `server/sync_core.py:51,65`; web `replica/apply.ts:326-333` |
| `OpKind` | create, update_text, move, delete, set_collapsed, set_heading, set_view_type, create_page | per-op Literals in `contracts/ops.py:32-111`, widened back to `str` in `SkippedOp.op` (`contracts/responses.py:466`, filled at `server/ops_core.py:456`) |
| `HeadingLevel` | 1, 2, 3, or None | `Field(ge=1, le=3)` at `contracts/ops.py:41,98`, `contracts/responses.py:33,330`, `planning.py:26`; web `outline/edits.ts:497`, `outline/slashCommands.ts:65-77`, `outline/keyboardPolicy.ts:245-251` |
| `AssistantModel` | sonnet, opus, haiku, glm | `assistant/policy.py:20,85`, `assistant/routes.py:179`, `contracts/responses.py:387`; web hardcodes a list at `assistant/useAssistant.ts:82` |
| `TaskMark` | TODO, DONE | `client/workflows.py:75,91`, `mcp/server.py:112` (MCP tool schema exposes bare `str`), `cli/main.py:511` |
| `AssetCategory` | image, pdf, document, other | `assets_core.py:29,40` |
| `ChangeStatus` | new, edited | `changed.py:62` returns `str`; `ChangedItem.status` is already a Literal |
| `QueueBlockReason` | offline, retryable, recovering, disposed | already a union at `web/src/sync/queueState.ts:9`, hand-copied at `sync/opQueue.ts:59-60,307-309` |
| `SlashCommandName` | the names in `SLASH_COMMANDS` | spelled out in three places: the array, `HEADING_COMMANDS` and the `switch` (`outline/slashCommands.ts:19-21,65-77,112-116,153`) |

## Tombstone dispatch (latent bug)

`applyWindow` (`web/src/replica/apply.ts:325-333`) handles `block`, then `page`, and treats **anything else** as a sidebar delete: `DELETE FROM sidebar_entries WHERE id = Number(entity_id)`. Today the server's CHECK bounds the kind. But an older client that meets a kind added later on the server would delete an unrelated sidebar row. An `EntityKind` union alone doesn't change this, because the `else` still compiles.

## Plan

- [x] Py Literals above; regen `openapi.json` + `pnpm gen-types` (see the regen and parity checklist)
- [x] Web: import the generated unions and delete the copies (`replica/refs.ts:14`, `assistant/useAssistant.ts:82`, `opQueue.ts` `QueueBlockReason` copies)
- [x] Failing test: a tombstone with an unknown kind deletes nothing
- [x] Tombstone dispatch: explicit `kind === "sidebar"` branch; the default skips (and logs) behind a compile-time `never` check
- [ ] Optional: discriminated `SyncTombstone` (kind → `entity_id` type) to drop the `Number(...)` casts -- skipped, see summary
- [x] `SlashCommandName` derived from the array (`as const`)

## Summary of changes

All ten Literals landed (`RefKind` in `refs.py`; `EntityKind`, `AssistantModel`,
`ChangeStatus`, `OpKind` reused in `SkippedOp.op` in `contracts/responses.py`;
`HeadingLevel`, `OpKind` in `contracts/ops.py`; `TaskMark` in `todo.py`;
`AssetCategory` in `assets_core.py`), threaded through every call site the
table named plus a few the regen/typecheck loop surfaced (`planning.py`'s
`split_heading`/`resolve_parent`/`Planner.heading`/`plan_mark`, `batch.py`'s
caller of `planner.heading`, `assistant/service.py`'s `create()`/
`available_models`, `mcp/server.py`'s `update_block`). `openapi.json` +
`types.d.ts` regenerated; web imports the generated unions in
`replica/refs.ts` (RefKind), `assistant/client.ts`+`useAssistant.ts`
(AssistantModel), `opQueue.ts` (QueueBlockReason), and `outline/edits.ts`/
`handlers.ts`/`keyboardPolicy.ts`/`slashCommands.ts`/
`EditableBlockTree.tsx`/`replica/localApi/tree.ts` (HeadingLevel, since
`SetHeadingOp.heading` narrowing to `1|2|3|null` forced the whole heading
chain off bare `number`).

Tombstone dispatch: `apply.ts`'s `applyWindow` now has an explicit
`kind === "sidebar"` branch; the final `else` assigns `tomb.kind` to a
`const x: never`, so an `EntityKind` added without updating this dispatch
is a compile error, and at runtime an unrecognised kind deletes nothing
(just logs). Test-first: `apply.test.ts` "an unknown tombstone kind deletes
nothing" failed against the old fallthrough (sidebar row count 1 -> 0)
before the fix, now passes.

Discriminated `SyncTombstone` skipped: `entity_id` is `str` on the wire for
every kind alike (a block uid and a stringified page/sidebar id both arrive
as plain strings), so splitting one model into three by `kind` would not
give `entity_id` a different type per kind and would not drop the
`Number(...)` casts in `apply.ts` -- that needs the `PageId`/
`SidebarEntryId` NewTypes pkm-9km9 is scoped to mint first. Not clean yet,
so not done here.

Docs: `backend.md`'s HTTP API reference intro names the new Literals
alongside `ViewType`/`SkipReason`; `sync-and-offline.md` § The changes feed
gets a clause on the per-kind dispatch invariant; `troubleshooting.md` gets
one row for the tombstone-dispatch latent bug (`pkm-38w9`).

Verification: `uv run pytest -q` (2242 passed), `uv run pyrefly check` (0
errors), `uv run ruff check` (clean); `pnpm build` and
`CI=true E2E_PORT=8976 pnpm verify` (typecheck + lint + fcis check +
3028 unit tests + coverage gate + 72 Playwright tests, exit 0).

No open questions.
