---
# pkm-e9ok
title: Show what the assistant is doing during a long silent turn
status: todo
type: feature
priority: normal
created_at: 2026-07-30T20:51:31Z
updated_at: 2026-08-04T18:52:15Z
---

**Draft on purpose — the question of whether to do this at all is still open.**
Follow-up to pkm-mbcc, which fixed the *transport* problem (a silent turn no
longer drops the connection, and the confirm prompt now arrives). What it
deliberately did not fix is that a long turn tells the user almost nothing about
what is happening.

## The gap

`AssistantPanel.tsx` renders one static line for the whole of
`status === "busy"`:

```jsx
{assistant.status === "busy" && <div className="assistant-tool-line">thinking…</div>}
```

No elapsed time, no phase, no change for the entire wait. Measured waits with
that line as the only feedback:

| Turn | Silent for | What was actually happening |
|---|---|---|
| pkm-mbcc incident, 8,575-char `batch` | 80s then 25s | reasoning, then serialising the tool call |
| pkm-mbcc live check, 48-block `save_note` | 53.7s | mostly serialising the tool call |

The user's read on shipping pkm-mbcc: *"a 54-second wait with no indication of
what it's doing is still a thin experience"* — but a product call, not a bug.

## New evidence: 2026-07-31 network-outage incident

A Tailscale/VPN clash killed connectivity mid-conversation and exposed a harder
variant of the same gap: **a dead network is indistinguishable from a thinking
model.** From the SDK session transcript and access log (times BST):

- 15:26:18 — `get_page` returned in 40ms; the model request went out and
  nothing ever came back. The panel showed `thinking…` for ~109s of pure
  dead air until the user interrupted manually.
- 15:30:35 — "try again" hung the same way for ~7.5 minutes; interrupted again.
- 15:38:08 — third attempt sat queued until ~15:41:40 when the network
  returned, then completed normally.

Nothing in the engine or UI surfaced an error at any point — the SDK's request
has no first-token timeout, so the turn waits forever and only the user's
patience ends it. For contrast, once connectivity was back the actual work was
fast: each `batch` executed in 3–6s end-to-end (server-side `POST /api/ops`
61ms); the honest per-batch cost is ~48–66s of token generation before the
tool call appears, which is exactly the silent window this bean is about.

This adds a requirement the display options below don't cover on their own:

**D. First-token timeout / connection-error surfacing.** Server-side: if no
stream event arrives within some window (say 60-90s), emit an error event
("no response from model — network?") instead of waiting indefinitely. This is
the only option that distinguishes "stuck" from "slow", which option A's
elapsed timer deliberately does not. Composes with A/B; independent of C.

## Why the panel knows so little

`TurnMapper.map` (`claude_engine.py`) inspects `StreamEvent` only for
`content_block_delta` with a `text_delta`. Two consequences:

- `thinking_delta` produces nothing — reasoning is invisible by construction.
- `input_json_delta` produces nothing either, **and** `ToolStarted` is built from
  the complete `AssistantMessage`, which the SDK only emits once the whole
  `tool_use` block has been assembled. So the tool's *name* is not surfaced until
  the end of the very window that is longest and most silent. For the 48-block
  save that is ~25-50s during which the server already knows a `save_note` is
  coming and says nothing.

## Options, cheapest first

**A. Elapsed time only. No protocol change.** The panel already knows when the
turn started; render `thinking… 47s`. Pure web change, no new event type, no
server work. Answers the actual anxiety ("is this stuck?") without answering
"what is it doing".

**B. Phase labels, no reasoning content.** Surface *that* the model is reasoning
vs. *that* it is preparing a specific write, e.g. `reasoning…` →
`preparing save_note…`. This is the option with the best value-to-risk ratio,
because it moves the tool name ~25-50s earlier — arguably a small safety win too,
since the user learns a write is coming before being asked to approve it.

  First verification step for whoever picks this up: dump raw `StreamEvent`s from
  a live turn and confirm the SDK forwards `content_block_start`. The raw
  Messages API includes the tool name there (`{"type":"tool_use","name":…}`), and
  `TurnMapper` already treats `msg.event` as raw API shapes, so it should be
  present — but `content_block_start` is entirely unexamined by our code today,
  so confirm before designing around it. Don't trust this paragraph over a dump.

**C. Stream the thinking text itself.** Most informative and the biggest change:
a new event type, collapsible UI (raw reasoning is long and rambling), and a
judgement call about whether model reasoning belongs rendered inside a notes app
at all. Also the only option where the panel's content is no longer just "what
the assistant said and did".

A and B compose: elapsed time plus a phase label is probably the whole feature.

## Open questions for the user (why this is a draft)

- Is "is it stuck?" the real complaint (→ A is enough), or "what is it doing?"
  (→ B), or "let me watch it think" (→ C)?
- Does raw reasoning text belong in the panel at all? A firm no here kills C and
  simplifies everything.
- Worth it for opus (which thinks much longer than the default sonnet), or only
  worth it if it's cheap?
- What timeout window is right for D, given legitimate turns already reach
  ~110s of silence before the first stream event? Too short and it fires on
  honest thinking; a first *stream event* (not first text) deadline may allow
  a much tighter window — verify what the SDK emits during pure reasoning.

## If B or C goes ahead: the enumeration tax

A new assistant event type is a **seven-place** change, and the docs count them.
`CLAUDE.md` warns that counts and enumerations go stale silently — grep for the
old set before claiming done:

- `server/src/pkm/assistant/events.py` — the dataclass, the `AssistantEvent`
  union, and `_EVENT_NAMES`
- `web/src/assistant/sse.ts` — the `AssistantEvent` union *and* the `EVENT_TYPES`
  set (a name missing from the set is silently dropped — which is exactly the
  mechanism that makes keepalive comment frames invisible, so this is a real
  failure mode, not a theoretical one)
- `web/src/assistant/useAssistant.ts` — `applyEvent`'s switch
- `web/src/assistant/AssistantPanel.tsx` — how it renders
- `docs/architecture/backend.md` — the `events.py` table row lists all six types,
  and the API reference table lists them again on the `/messages` row
- `docs/architecture/frontend.md` — the assistant-panel section names them too

Option A touches none of this, which is most of its appeal.

## Plan

Deliberately empty. Answer the open questions first, then
`/superpowers:brainstorming` before any implementation plan.
