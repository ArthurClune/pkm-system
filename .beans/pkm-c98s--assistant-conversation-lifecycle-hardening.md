---
# pkm-c98s
title: Assistant conversation lifecycle hardening
status: todo
type: task
created_at: 2026-07-26T23:40:43Z
updated_at: 2026-07-26T23:40:43Z
---

Follow-ups from the pkm-wn2s final review (deferred knowingly at merge):

- [ ] Orphaned-conversation lockout: page reload loses the conversation id without deleting server-side; 3 reloads mid-conversation exhaust the 3-cap and the next create 409s for up to 15 min. Prefer evicting the oldest idle conversation instead of 409ing, and/or delete-on-pagehide (sendBeacon).
- [ ] Interrupt the harness when the SSE consumer drops mid-turn (send() cancels the pump but the CLI may keep executing the old query; consider client.interrupt()).
- [ ] Stop button / AbortController for streamMessage (no way to cancel a slow turn; max_turns=40 can pin the panel at 'thinking…').
- [ ] useAssistant could recover from 404-after-reap by resetting conversationId and retry-creating once.
- [ ] ApiError discards the server's detail body — surface it so 409 'at most 3 concurrent conversations' isn't shown as a bare status code.
- [ ] ops_preview clips values at 120 chars, so users approve writes they can't fully see — add a SECURITY.md sentence or an expandable preview.
- [ ] Minor: busy-check race in service.send (two near-simultaneous POSTs serialize instead of the second 409ing; harmless single-user).

Context: docs/superpowers/plans/2026-07-26-pkm-wn2s-assistant.md, final whole-branch review 2026-07-27.
