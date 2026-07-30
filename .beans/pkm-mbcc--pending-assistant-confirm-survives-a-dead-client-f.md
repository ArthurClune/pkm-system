---
# pkm-mbcc
title: A large batch write never reaches the user for confirmation
status: todo
type: bug
priority: high
created_at: 2026-07-30T20:02:45Z
updated_at: 2026-07-30T20:02:45Z
---

Asking the assistant to restructure a large block produces **no permission
prompt at all**, and leaves the harness parked forever. Two independent defects,
both confirmed on 2026-07-30 against conversation `5b72cf28aadf0861` (an
8,575-char `batch` on the "AI Pricing" page).

This bean replaces an earlier, wrong reading of the same incident ("cleanup is
correct, just slow"). Both claims below are backed by evidence, not inference.

## Defect 1: no heartbeat, so a long silent gap kills the stream

Gaps measured from the harness transcript (see "Where the evidence is"):

| Time (local) | Event | Silence before |
|---|---|---|
| 20:40:46 | user message arrives | -- |
| 20:42:06 | thinking block | **80s** |
| 20:42:08 | 519 chars of text | 2s |
| 20:42:33 | `batch` tool call, 8,575 chars of JSON | **25s** |

For 105 of those 107 seconds the SSE stream carried nothing at all. Thinking is
invisible: `TurnMapper.map` (`claude_engine.py`) forwards only `text_delta`, so
`thinking_delta` events produce no output. `SSE_HEADERS` (`routes.py`) sets only
`Cache-Control` and `X-Accel-Buffering` -- there is no keepalive frame. A mobile
client that backgrounds, or any NAT/proxy idle timeout, drops the connection
during that window, and the confirm frame is then written into a dead socket
(a small write to a dead-but-unreset TCP connection succeeds locally, so the
server sees no error).

**Both silent halves scale with the size of the block being restructured** --
more input to reason about, and a bigger tool-call payload to serialise. So the
edits most worth confirming are the ones whose confirmation is least likely to
arrive. Small edits answer in seconds and their prompts land fine, which is why
this looked healthy until now.

Ruled out: `web/src/assistant/sse.ts` buffers correctly across chunk boundaries
and only emits on `\n\n`, so a large frame split across reads is NOT the
problem. Don't re-investigate the parser.

## Defect 2: a parked confirm is never declined on disconnect

`ClaudeConversation.send`'s `finally` (`claude_engine.py:159-183`) awaits
`self._client.interrupt()` **before** the loop that resolves pending futures to
`False`. But `interrupt()` cannot return while the harness sits inside
`can_use_tool` awaiting the very decision that loop would supply. The decline
loop is therefore unreachable in exactly the case it exists for.

Reproduced standalone: an async generator whose `finally` awaits a hanging
`interrupt()` under `contextlib.suppress(Exception)` never reaches the following
statement.

Evidence it happened: the batch's `tool_result` appears in the harness
transcript only at **21:08:55**, the moment the deploy restarted the server --
`close_all()` -> `close()` resolves pending futures *first*, then disconnects.
Not at 20:51:09 when the request completed (623174ms, logged). `close()` has the
correct order; the disconnect path has it backwards.

Consequences while parked: the harness subprocess and its MCP child stay alive
CPU-idle, and the panel looks hung with no signal anywhere. (`entry.busy` is
cleared by `_stream`'s own `finally` in `service.py`, so idle reaping is not
blocked -- but reaping is lazy, only running on the next `create()`.)

## Also required: correct a false claim now in the docs

`docs/SECURITY.md`, "Embedded assistant" -> "Turn cancellation" bullet, added in
6a7d41f, asserts:

> Any confirmation still awaiting a decision is resolved as declined on the same
> path, so a `can_use_tool` hook cannot outlive the stream that would have
> answered it.

Defect 2 disproves this. The following paragraph about unbounded disconnect
*detection* is also framed wrongly -- the problem is ordering, not just
detection latency. Both need rewriting in the same branch as the fix.

## Plan

- [ ] Failing test: a dropped consumer with a confirm pending declines that
      confirm promptly, even when `interrupt()` never returns (fake client whose
      `interrupt()` blocks forever)
- [ ] Reorder the disconnect cleanup: resolve pending futures BEFORE awaiting
      `interrupt()`, and bound the `interrupt()` await so cleanup cannot block
      on a wedged harness
- [ ] Failing test: an idle turn emits keepalive frames on the SSE stream
- [ ] Add a periodic SSE comment frame (`:\n\n`) while a turn is in flight --
      keeps the connection alive through silent gaps AND makes a dead peer
      surface on the next write. Must not be parsed as an event by `sse.ts`
      (verify: `parseFrame` returns null for a comment frame)
- [ ] Consider surfacing thinking/progress so a long turn isn't dead air to the
      user either (optional, decide explicitly rather than by omission)
- [ ] If a pending-confirm timeout is added too, a timed-out confirm must reach
      the panel as an explicit message, not a silent deny
- [ ] Rewrite the two `docs/SECURITY.md` paragraphs described above
- [ ] Full server verification: `cd server && uv run pytest -q`, `uv run pyrefly
      check`, `uv run ruff check`
- [ ] Web verification if `sse.ts`/panel change: `cd web && pnpm verify`
- [ ] Live check with the real harness (recipe below) -- the small-payload happy
      path passes regardless, so the check must involve a genuinely slow turn

## Where the evidence is

- Harness transcripts (ground truth for what the assistant did, including full
  `tool_use` inputs): `~/.claude/projects/-Users-arthur--config-pkm-app-server/*.jsonl`.
  The incident is `2c3820a7-3814-4b54-9db4-ab5c9f3c9d67.jsonl`. A `tool_use` with
  no following `tool_result` = still parked on permission.
- Server logs: `~/.config/pkm/logs/server.out.log` (`pkm.access`, one line per
  request **on completion** -- an in-flight SSE has no line at all, so a missing
  line means still running, not never started) and `server.err.log` (WebSocket
  lifecycle, uvicorn).
- To tell whether a client is really connected, ignore the WS log (a dead TCP can
  leave the server believing a socket is open for minutes) and use
  `lsof -nP -p <server pid> | grep TCP`.

## Live verification recipe (worked 2026-07-30)

The `verify` skill's scratch-server recipe, plus: point `web_dist` at the main
checkout's `web/dist` (a fresh worktree has no build), and drive the assistant
over HTTP rather than the browser -- create a conversation, stream
`POST /messages` with an httpx client, and POST `/confirm` from a background
thread when the `confirm_request` event arrives. Derive block uids from the page
at runtime; hardcoded uids silently make the model give up without writing.
Never test against port 8974 (prod launchd service).
