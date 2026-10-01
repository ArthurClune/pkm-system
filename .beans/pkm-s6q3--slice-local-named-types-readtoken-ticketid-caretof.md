---
# pkm-s6q3
title: Slice-local named types (ReadToken, TicketId, CaretOffset, DnD drop, GoodlinksId, assistant ids)
status: todo
type: task
priority: low
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T07:44:38Z
parent: pkm-7uxw
---

Small named types the review found that stay inside one area. Each is low cost and independent; pick them up opportunistically.

- [ ] `RequestId` / `Revision` on the outline `ReadToken`: two same-typed counters compared on one line (`web/src/outline/outlineState.ts:15-17,33-34,99-102`; `outline/outlineSessions.ts:233-234`)
- [ ] `TicketId`: three `string`-keyed maps in `outline/outlineSessions.ts:136,145,155`, some keyed by title and some by ticket; minted at `sync/opQueue.ts:131`
- [ ] `CaretOffset` (UTF-16 code units), to document the unit: `outline/keyEdits.ts:13-17`, `outline/edits.ts:14-17`, `components/BlockInput.tsx:32-36`. No code-point mixing was found.
- [ ] DnD `{boundary, depth}` as a named object instead of adjacent numbers (`outline/dnd.ts:54,87-89`, `dnd/useDropZone.ts:33,146-147`)
- [ ] `GoodlinksId` (fixed 32-hex, one mint point per side): Py `server/src/pkm/goodlinks.py:22,46`; web `components/goodlinks.ts:9`, `components/GoodlinksReader.tsx:36-50`
- [ ] `ConversationId`, and `ConfirmId` for the value currently misnamed `tool_use_id` (it isn't the SDK's id): `server/src/pkm/assistant/service.py:137`, `assistant/claude_engine.py:160-161`
