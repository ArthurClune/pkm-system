# pkm-wn2s: Embedded LLM assistant ("ask my PKM") — design

Date: 2026-07-26
Bean: [[pkm-wn2s]]

## Goal

An LLM assistant inside the app that can answer "find what I've written about X"
(retrieval Q&A over the PKM verbs) and "suggest how to reorganize this page"
(editorial judgment plus gated atomic writes), summoned as a floating chat panel
from anywhere in the app.

## Decisions made during brainstorming

- **Server-side agent.** All inference calls, credentials, and tool execution
  run in the FastAPI server. The browser is a thin chat UI. Rationale:
  provider credentials must never reach the browser (SECURITY.md posture), the
  ChatGPT/Codex endpoints are not CORS-open anyway, and the tool surface
  already lives server-side.
- **Harness-based engine, not a hand-rolled loop.** The assistant service
  abstracts over *agent engines* rather than chat-completion APIs. v1
  implements a Claude Agent SDK backend; an OpenAI-subscription engine
  (Codex SDK or pi) is a follow-up that validates the abstraction. Rationale:
  harnesses are the only sanctioned path to *subscription* auth for both
  vendors — Anthropic's ToS (2026-02) bans subscription OAuth tokens in
  third-party tools, but the Agent SDK *is* Anthropic's own harness and uses
  the Claude Code Max-plan login already present on this machine; OpenAI
  explicitly permits ChatGPT-subscription use via the Codex flow in third-party
  tools. This makes marginal inference cost ~zero, which was the driving
  constraint.
- **Writes enabled, gated by in-chat confirm.** Full verb surface exposed;
  every write tool call pauses the loop and renders a confirm card before
  executing.
- **Model choice is per-conversation** via a dropdown in the panel header —
  Sonnet (default), Opus (heavy reorg escalation), Haiku (cheap read-only
  experiment). Locked once the conversation starts; validated server-side
  against an allowlist.
- **UI:** floating panel toggled by `Cmd/Ctrl+J` (and Esc to close), plus an
  "Assistant" entry in the LH sidebar's secondary section above Settings.
  Help stays in the TopBar.
- **Ephemeral conversations.** Held in server memory while the panel session
  lives; no DB schema, no history UI.
- **Out of scope (follow-up beans):** network-facing streamable-HTTP MCP
  endpoint for tailnet clients; persistent conversation history; the second
  engine backend; any Settings-page configuration.

## Architecture

```
Floating chat panel (web) ── /api/assistant/* (session cookie, SSE) ──> FastAPI
                                                                          │
                                              assistant service (server-side)
                                                │            │
                                     AgentEngine abstraction  └─ conversation registry (in-memory)
                                                │
                                  ClaudeAgentSDK backend (v1)  … Codex/pi engine (later)
                                                │  spawns harness; Max-plan login from ~/.claude
                                                └─ tools = PKM MCP server ONLY (stdio pkm-mcp)
```

New package `server/src/pkm/assistant/`:

| File | Pattern | Responsibility |
|---|---|---|
| `events.py` | Functional Core | `AssistantEvent` tagged union + SSE encoding |
| `policy.py` | Functional Core | tool-gate policy (read allowlist vs confirm-gated writes), model allowlist/resolution, system-prompt assembly, ops-preview rendering |
| `engine.py` | Functional Core (types) | `AgentEngine` / `ConversationHandle` protocols |
| `claude_engine.py` | Imperative Shell | Claude Agent SDK adapter |
| `service.py` | Imperative Shell | conversation registry, caps, idle reaping |
| `routes.py` | Imperative Shell | HTTP/SSE endpoints |

## Engine abstraction

```
AgentEngine.create_conversation(system_prompt, model) -> ConversationHandle
ConversationHandle.send(text) -> AsyncIterator[AssistantEvent]
ConversationHandle.resolve_confirm(tool_use_id, allow: bool)
ConversationHandle.close()
```

`AssistantEvent` union: `text_delta`, `tool_started(name, summary)`,
`tool_finished(name)`, `confirm_request(tool_use_id, ops_preview)`,
`turn_done(usage)`, `error(message)`. Routes and UI speak only these events;
nothing engine-specific leaks upward.

## Claude Agent SDK backend

- Python `claude-agent-sdk`, driving the `claude` CLI installed and logged in
  (Max plan) as the service user. Node + claude CLI become prod dependencies.
- Model passed per conversation (`sonnet` | `opus` | `haiku` aliases).
- **Tool confinement:** all built-in tools disabled (no Bash/Read/Write/Web*).
  `mcp_servers` = the existing `pkm-mcp` stdio server, so the assistant's
  entire world is the ten PKM tools (`get_page`, `get_block`, `search`,
  `query`, `backlinks`, `todos`, `save_note`, `update_block`, `batch`,
  `upload_asset`).
- **Subprocess auth:** the server mints a fresh session cookie (it holds
  `session_secret`) and writes a private config for the subprocess, passed via
  `PKM_CLI_CONFIG`, pointing at `127.0.0.1:<port>`. No dependency on the
  user's personal `~/.config/pkm-cli/config.json`.
- **Write gate:** the SDK's `can_use_tool` hook auto-allows read verbs; write
  verbs (`save_note`, `update_block`, `batch`, `upload_asset`) emit
  `confirm_request` with a human-readable ops preview and block until the UI
  answers. Deny returns a "user declined" tool result so the model can adapt.
- Custom PKM-assistant system prompt replaces the harness's coding default.

## HTTP surface (all behind `require_auth`)

- `POST /api/assistant/conversations` `{model?}` → `{id, model}`
- `POST /api/assistant/conversations/{id}/messages` `{text}` → SSE response
  streaming that turn's events (first SSE in the app; FastAPI
  `StreamingResponse`, consumed via `fetch` + stream reader because
  `EventSource` cannot POST)
- `POST /api/assistant/conversations/{id}/confirm` `{tool_use_id, allow}`
- `DELETE /api/assistant/conversations/{id}`

Registry caps concurrent conversations (3) and reaps idle ones (~15 min).
Server restart discards them.

## Frontend

- Floating overlay panel (bottom-right, not a route). Toggle: `Cmd/Ctrl+J`
  global handler in `App.tsx` (drift-guard: update `keyboard.md`/help page);
  Esc closes. Sidebar: "Assistant" button in the secondary section above
  Settings, toggling the same panel.
- Panel: header with model dropdown (Sonnet default; disabled once the
  conversation has messages; New Chat re-enables), message list with streamed
  markdown, subdued tool-activity line ("searching *quarterly review*…"),
  confirm card (ops summary + Allow/Deny), input box.
- `useAssistant` hook owns state; small SSE-parsing client module. Existing
  design tokens (`--radius-*`, `.btn-secondary`).

## Security

- No new public routes; assistant endpoints sit behind the existing
  session-cookie auth. Provider credentials never reach the browser.
- Prompt-injection containment: note content is untrusted input to the model.
  The blast radius of a fully injected model is the ten PKM tools, and the
  write verbs still require explicit user confirmation in the UI. No shell,
  no filesystem, no web tools.
- Harness subprocess spawned with a minimal environment; the minted session
  token is scoped to a private config file (0600) and the loopback listener.
- SECURITY.md gets an addendum describing the assistant threat model.

## Testing

- Unit tests for the Functional Core: event mapping, SSE encoding, gate
  policy, model resolution, ops-preview rendering.
- Route tests against a `FakeEngine` (scripted event sequences, including
  confirm round-trips).
- One Playwright e2e driving the panel against the fake engine (selected via
  env flag) — no real LLM in CI.
- Usual gates: `uv run pytest`, `uv run pyrefly check`, `uv run ruff check`,
  `pnpm verify`.

## Risks

- **Policy risk:** Anthropic could tighten Agent-SDK-with-subscription terms.
  Mitigation: the engine abstraction; the OpenAI/Codex engine is the planned
  second backend.
- **Prod dependencies:** node + `claude` CLI + a logged-in Max session must
  exist for the launchd service user; deploy docs need a note.
- **Harness startup latency** (~1–2 s per conversation) — acceptable
  single-user; conversations are reused across turns.
