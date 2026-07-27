---
# pkm-c98s
title: Assistant conversation lifecycle hardening
status: completed
type: task
priority: normal
created_at: 2026-07-26T23:40:43Z
updated_at: 2026-07-27T18:23:00Z
---

Follow-ups from the pkm-wn2s final review (deferred knowingly at merge):

- [x] Orphaned-conversation lockout: page reload loses the conversation id without deleting server-side; 3 reloads mid-conversation exhaust the 3-cap and the next create 409s for up to 15 min. Prefer evicting the oldest idle conversation instead of 409ing, and/or delete-on-pagehide (sendBeacon).
- [x] Interrupt the harness when the SSE consumer drops mid-turn (send() cancels the pump but the CLI may keep executing the old query; consider client.interrupt()).
- [x] Stop button / AbortController for streamMessage (no way to cancel a slow turn; max_turns=40 can pin the panel at 'thinking…').
- [x] useAssistant could recover from 404-after-reap by resetting conversationId and retry-creating once.
- [x] ApiError discards the server's detail body — surface it so 409 'at most 3 concurrent conversations' isn't shown as a bare status code.
- [x] ops_preview clips values at 120 chars, so users approve writes they can't fully see — add a SECURITY.md sentence or an expandable preview.
- [x] Minor: busy-check race in service.send (two near-simultaneous POSTs serialize instead of the second 409ing; harmless single-user).

Context: docs/superpowers/plans/2026-07-26-pkm-wn2s-assistant.md, final whole-branch review 2026-07-27.

## Summary of Changes

All seven items done on branch `pkm-c98s-assistant-lifecycle`.

Server (`server/src/pkm/assistant/`):
- `service.py`: `create()` now evicts the least-recently-used **idle**
  conversation when at the 3-conversation cap instead of 409ing (still
  409s if every conversation is genuinely busy). Fixed a check-then-act
  race in `send()` by reserving a synchronous `busy` flag (replacing the
  `asyncio.Lock`, whose acquisition only happened once the lazy generator
  started running) instead of one derived from lock state.
- `routes.py`: the conversation-delete route also accepts POST (own
  `operation_id`, same handler) so `navigator.sendBeacon` — which can only
  POST — can close a conversation on `pagehide`.
- `claude_engine.py`: `ClaudeConversation.send()` calls `client.interrupt()`
  when the SSE consumer disconnects mid-turn, instead of only cancelling
  the local pump task (which left the CLI subprocess still executing the
  abandoned query); also declines any pending `can_use_tool` confirm so
  that coroutine can't hang forever.
- `policy.py`: `ops_preview` (the write-approval text) now clips at 4000
  chars instead of 120; `tool_summary`'s 120-char clip (the transient
  "tool running" line) is untouched.
- `tests/fake_engine.py`: added a "please hang" scripted scenario (blocks
  until cancelled) so e2e can drive the Stop button.
- Regenerated `web/src/api/openapi.json` + `types.d.ts`.

Web (`web/src/`):
- `api/client.ts`: `ApiError` now carries the server's `detail` string and
  includes it in the message; this is a global fix, not assistant-only
  (updated two pre-existing sync tests whose exact-message assertions
  didn't account for `detail`).
- `assistant/client.ts`: `streamMessage()` takes an `AbortSignal`; added
  `closeConversationBeacon()`.
- `assistant/useAssistant.ts`: `pagehide` listener beacons the live
  conversation closed; `stop()` aborts the in-flight turn via
  `AbortController` (its `AbortError` is treated as success, not a
  failure); a 404 from `streamMessage` resets the conversation id and
  retries once against a fresh conversation; error messages prefer
  `ApiError.detail`; `respondConfirm()` also recovers from a 404 instead of
  resurrecting a dead confirm card. Added a short bounded retry (5 x 60ms)
  for a 409 on the message endpoint, because `AbortController.abort()`
  resolves the client's fetch before the server has processed the
  disconnect and released the busy flag — a Stop-then-immediate-resend can
  otherwise transiently 409.
- `AssistantPanel.tsx`: Stop button replaces Send while busy; the confirm
  card collapses previews over 300 chars behind a "Show full preview"
  toggle (keyed by `tool_use_id` so a new request always starts collapsed).
- `e2e/assistant.spec.ts`: added Stop-button and pagehide/sendBeacon specs.
- `docs/SECURITY.md`: documented the new preview bound + expandable UI,
  oldest-idle eviction + sendBeacon cleanup, and turn cancellation via
  engine interrupt.

Verification: `server && uv run pytest -q` (752 passed, 95.76% cov),
`pyrefly check` (0 errors), `ruff check` (clean); `web && pnpm verify`
(typecheck + lint + fcis + unit coverage 97.27/92.23/94.8/97.27 + build +
full Playwright e2e, 37 passed) all green. `e2e/wrapped-arrow.spec.ts`
flaked once during iteration (pre-existing, timing-sensitive, unrelated to
this diff — nothing here touches block editing/caret/arrow-key code) and
passed clean on the next two runs.

Needs a **live** engine smoke (FakeEngine/CI cannot cover): that a real
dropped SSE connection (browser navigation, or clicking Stop against a
live Claude CLI harness turn) actually reaches Starlette's disconnect
detection quickly enough to call `ClaudeConversation.send()`'s
`client.interrupt()`, and that a live `ClaudeSDKClient.interrupt()` truly
stops the in-flight CLI turn (unit tests cover the plumbing with a fake
SDK client, per `claude_engine.py`'s existing test-double pattern; they
cannot cover the real subprocess's response to `interrupt()`).
