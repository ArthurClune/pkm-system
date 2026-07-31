---
# pkm-6ts2
title: 'Assistant: prevent New chat from racing an active turn'
status: completed
type: bug
priority: high
created_at: 2026-07-31T16:05:42Z
updated_at: 2026-07-31T20:08:00Z
parent: pkm-6phf
---

Finding 2 of epic pkm-6phf (web review).

**References:** web/src/assistant/useAssistant.ts:132-178,212-227; web/src/assistant/AssistantPanel.tsx:100-102

newChat() clears state and the conversation ID without aborting or superseding the active stream. Old SSE events and finalizers can repopulate the new transcript, clear a newer abort controller, reset a newer turn to idle, or overwrite confirmation state.

**Direction:** Give each turn a generation/token and ignore updates from superseded turns. Abort and await the active turn before resetting, and identity-check abort-controller cleanup. Alternatively, disable New chat until Stop has completed.

- [x] Add active-turn/new-chat race tests
- [x] Make turn cleanup generation- and controller-safe

## Summary of Changes

Confirmed four distinct races in `useAssistant.ts`, all stemming from `newChat()` never superseding the in-flight turn:

1. **Late SSE events** — `runTurn`'s `onEvent` callback kept calling `applyEvent` after `newChat` reset the transcript, so a dead turn's `text_delta`/`tool_started`/`confirm_request`/`error` events repopulated the *new* chat.
2. **`send`'s `finally`** — unconditionally reset `status` to `"idle"` and cleared `pendingConfirm`, so a superseded turn's completion could stomp a newer turn's busy/confirm state.
3. **`runTurn`'s controller cleanup** — unconditionally nulled `abortController.current`, so if a newer turn had already installed its own controller, the older turn's cleanup discarded it and `stop()` became a no-op.
4. **In-flight `createConversation` adoption** — if `newChat` ran while `createConversation` was still pending, its resolution wrote the *old* id into `conversationId.current`, silently continuing the old conversation under the "new" chat.

**Fix:** a `turnGen` ref counts turn generations. `send()` takes the next generation and threads it through `runTurn`; `newChat()` bumps it first, before doing anything else, which is what makes its synchronous state clear (empty transcript, idle status, unlocked model) safe to do immediately rather than after the abort round-trip completes. Every state write that happens after an `await` — the per-event callback, `send`'s error/finally handling, `respondConfirm`'s catch branches, and the 404-retry in `runTurn` — is gated on `gen === turnGen.current`. `runTurn`'s `abortController.current = null` cleanup is identity-checked (`=== controller`) instead of unconditional, so a newer turn's controller survives a superseded turn's `finally`. A new `activeTurn` ref holds the currently-running turn's promise; `newChat` aborts the controller (if a stream had actually started) and awaits that promise before issuing the `DELETE`, so the server has observed the dropped connection and the old turn's finalizers have all run first. If the superseded turn was still inside `createConversation` (no stream, no controller yet), `newChat` does not block on it — it closes the conversation itself via the generation check inside `runTurn` once `createConversation` resolves, rather than leaking it or waiting on an arbitrary-length request.

`AssistantPanel.tsx` needed no code change and was left with "New chat" enabled at all times, rather than disabling it until `stop()` completes (the bean's alternative direction): the race is fixed at the hook level via generations, and disabling the button would remove the user's escape hatch exactly when a turn is stuck — the situation where they most need it.

Six new tests added to `useAssistant.test.tsx` covering: late-event suppression after `newChat`, a superseded turn's abort not surfacing as an error, a newer turn keeping its own stoppable controller, a conversation created by a superseded turn being closed rather than adopted, `newChat`'s synchronous state clear (matching `AssistantPanel`'s fire-and-forget `void assistant.newChat()` click), and `respondConfirm` from a superseded turn being unable to clobber the replacement chat.
