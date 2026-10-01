---
# pkm-s6q3
title: Slice-local named types (ReadToken, TicketId, CaretOffset, DnD drop, GoodlinksId, assistant ids)
status: completed
type: task
priority: low
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T14:11:47Z
parent: pkm-7uxw
---

Small named types the review found that stay inside one area. Each is low cost and independent; pick them up opportunistically.

- [x] `RequestId` / `Revision` on the outline `ReadToken`: two same-typed counters compared on one line (`web/src/outline/outlineState.ts:15-17,33-34,99-102`; `outline/outlineSessions.ts:233-234`)
- [x] `TicketId`: three `string`-keyed maps in `outline/outlineSessions.ts:136,145,155`, some keyed by title and some by ticket; minted at `sync/opQueue.ts:131`
- [x] `CaretOffset` (UTF-16 code units), to document the unit: `outline/keyEdits.ts:13-17`, `outline/edits.ts:14-17`, `components/BlockInput.tsx:32-36`. No code-point mixing was found.
- [x] DnD `{boundary, depth}` as a named object instead of adjacent numbers (`outline/dnd.ts:54,87-89`, `dnd/useDropZone.ts:33,146-147`)
- [x] `GoodlinksId` (fixed 32-hex, one mint point per side): Py `server/src/pkm/goodlinks.py:22,46`; web `components/goodlinks.ts:9`, `components/GoodlinksReader.tsx:36-50`
- [x] `ConversationId`, and `ConfirmId` for the value currently misnamed `tool_use_id` (it isn't the SDK's id): `server/src/pkm/assistant/service.py:137`, `assistant/claude_engine.py:160-161`

## Summary of Changes

One commit per item, all six done:

1. **RequestId / Revision.** These are web-only brands on the outline
   `ReadToken` (`outline/outlineState.ts`, `outlineSessions.ts`). The two
   counters that are compared on one line can't be swapped, and a probe
   checks it.
2. **TicketId.** A web-only brand, minted in `sync/opQueue.ts`, that keys the
   write-ticket maps in `outlineSessions.ts`, so a ticket-keyed map can't be
   indexed by title.
3. **CaretOffset.** A documentation-only alias for UTF-16 code-unit offsets in
   `keyEdits.ts`, `edits.ts` and `BlockInput.tsx`. It is not branded, because
   no mixing of units was found and every DOM `selectionStart` read would
   otherwise need a cast.
4. **DropPosition.** A named `{ boundary, depth }` object replaces adjacent
   numbers in `outline/dnd.ts` and `dnd/useDropZone.ts`.
5. **GoodlinksId.** Fixed 32-character hex, with one validated mint point on
   each side: `server/src/pkm/goodlinks.py`, and `components/goodlinks.ts` /
   `GoodlinksReader.tsx`. It is tagged with `brand()` and reaches the
   generated types, and a non-hex id is rejected.
6. **ConversationId and ConfirmId.**
   - The value misnamed `tool_use_id` is a local confirm counter, not the
     SDK's tool_use id. It is renamed `confirm_id` end to end: `ConfirmRequest`,
     the SSE event, `ConfirmRequestBody`, and the web assistant client.
   - Both types are brands. `ConversationId` is minted at `secrets.token_hex`
     and at the route params.
   - Version skew: a tab left open across the deploy sends `tool_use_id` and
     reads no `confirm_id`, so its confirm dialog breaks until it reloads. The
     deploy restarts the server, which ends every assistant conversation
     anyway, so this is accepted.

Checks: pytest 2263 passed. pyrefly 0 errors, unchanged from main. ruff and tsc
clean. `pnpm verify` green, including 72 e2e tests. `perf/check.sh`: no changes
against the baseline, backend and frontend.
