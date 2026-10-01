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

- [ ] Py Literals above; regen `openapi.json` + `pnpm gen-types` (see the regen and parity checklist)
- [ ] Web: import the generated unions and delete the copies (`replica/refs.ts:14`, `assistant/useAssistant.ts:82`, `opQueue.ts` `QueueBlockReason` copies)
- [ ] Failing test: a tombstone with an unknown kind deletes nothing
- [ ] Tombstone dispatch: explicit `kind === "sidebar"` branch; the default skips (and logs) behind a compile-time `never` check
- [ ] Optional: discriminated `SyncTombstone` (kind → `entity_id` type) to drop the `Number(...)` casts
- [ ] `SlashCommandName` derived from the array (`as const`)
