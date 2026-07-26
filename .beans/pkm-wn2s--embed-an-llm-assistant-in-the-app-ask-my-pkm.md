---
# pkm-wn2s
title: Embed an LLM assistant in the app (ask-my-PKM)
status: completed
type: feature
priority: normal
created_at: 2026-07-24T16:48:39Z
updated_at: 2026-07-26T23:42:02Z
---

Expose the pkm CLI/MCP verb surface (search, get, refs, query, todos, save, update, batch) to an LLM inside the app. Two headline use cases, validated in the 2026-07-24 agent-driving session:

1. **"Find what I've written about X before"** — retrieval Q&A. The winning loop is search → get → refs (breadcrumbed backlinks) → get daily notes. Mechanical tool-calling; backlinks, not search, answered "who did I meet and when".
2. **"Suggest how to reorganize this page"** — editorial judgment + atomic `batch` writes (move/create/update/delete by uid). This is the quality-sensitive path.

## Model choice (decided 2026-07-24)

- **Sonnet-class is the floor.** Editorial/reorg suggestions are a headline feature and degrade most with model size — Haiku-tier gives shallower, more generic advice. Default: `claude-sonnet-5` ($3/$15 per MTok; intro $2/$10 through 2026-08-31).
- **Haiku 4.5 remains a candidate for read-only Q&A routing** if A/B shows it holds up (route by whether the request needs writes/synthesis). Not the default.
- **Opus-tier only as per-request escalation** for heavy cross-page restructuring, not a default.
- Frontier models (Fable-class) are overkill — the retrieval loop needs tool-call reliability, not deep reasoning.
- Vendor-agnostic in principle: the MCP server means any tool-calling model can drive the verbs; benchmark tool-call reliability (correct uid handling, no hallucinated verbs) rather than raw intelligence if comparing OpenAI mid-tier.

## Thinking/effort settings (Anthropic)

- Use **adaptive thinking** (`thinking: {type: "adaptive"}`) — never `budget_tokens` (removed on current models).
- Run **low effort for reads** (`output_config: {effort: "low"}`): the retrieval loop needs no deliberation, and low effort makes tool calls terser and faster. Medium/high only for reorg/synthesis requests.
- **Cache the static prefix** (system prompt + verb reference/tool schemas): per-turn cost then is mostly 0.1x cache reads — a whole investigation session lands in the cents range on Sonnet.
- **Superseded by the harness decision (2026-07-26):** the Claude Agent SDK owns thinking/effort/caching. These notes apply only if a raw-API engine is ever built.

## Architecture (decided 2026-07-26)

Design spec: `docs/superpowers/specs/2026-07-26-pkm-wn2s-assistant-design.md`

- Server-side agent, harness-based: `AgentEngine` abstraction with a Claude Agent SDK backend first (uses the machine's Claude Code Max login — sanctioned subscription path; Anthropic ToS bans subscription OAuth only in third-party tools). OpenAI-subscription engine (Codex SDK or pi) is the planned second backend.
- Harness confined to the stdio `pkm-mcp` tool surface only (no built-in tools); write verbs gated by in-chat confirm.
- Floating panel (`Cmd/Ctrl+J`, Esc closes) + "Assistant" sidebar entry above Settings; per-conversation model dropdown (Sonnet default / Opus / Haiku), server-validated.
- SSE streaming over `/api/assistant/*` behind existing session auth; ephemeral in-memory conversations.
- Follow-up beans: HTTP MCP endpoint for tailnet clients; persistent history; second engine.

## Dependencies

- [[pkm-roph]] CLI surface improvements are effectively model-downsizing work: exact search, query ref-expansion, resolved block refs, and self-sufficient --help all remove judgment calls the model currently papers over. The smarter the tool surface, the cheaper the model can be. Do pkm-roph first or alongside.

## Open questions

- [x] Where does the assistant live in the UI → floating panel, `Cmd/Ctrl+J` + sidebar entry above Settings
- [x] Server-side proxy for API keys vs BYO-key → server-side harness with subscription auth (no keys in v1)
- [x] Read-only first release, or writes → writes with in-chat confirm gate
- [x] Streaming + tool-call progress display → SSE turn stream; tool-activity line + confirm cards

## Implementation plan (2026-07-26)

Plan: docs/superpowers/plans/2026-07-26-pkm-wn2s-assistant.md (15 tasks, TDD, FakeEngine test strategy; e2e runs against FakeEngine wired into e2e_serve.py — no real LLM in CI). Execute with subagent-driven-development in a worktree.

## Summary of Changes (2026-07-27)

Shipped on branch worktree-pkm-wn2s (28 commits, merged to main):

- **Server** — new `pkm.assistant` package: `events.py` (event union + SSE encoding), `policy.py` (tool gate, model allowlist sonnet/opus/haiku, ops previews, system prompt), `engine.py` (AgentEngine/ConversationHandle protocols), `service.py` (in-memory registry: 3-conversation cap, lazy 15-min idle reap, per-conversation lock, close_all wired to app lifespan), `claude_engine.py` (Claude Agent SDK adapter: MCP-confined to the ten pkm tools, confirm-gated writes via can_use_tool, ENABLE_TOOL_SEARCH=false so MCP tools load eagerly, minted 0600 PKM_CLI_CONFIG per conversation), `routes.py` (app's first SSE endpoints under /api/assistant/*, behind require_auth).
- **Web** — new `src/assistant/` dir: SSE parser (Functional Core), fetch/stream client (shares the live 401 handler), `useAssistant` hook, floating `AssistantPanel` (Cmd/Ctrl+J + sidebar entry above Settings, model dropdown locks after first message, tool-activity lines, Allow/Deny confirm cards); keyboard.md row.
- **Tests** — FakeEngine double drives service/route tests (incl. threaded HTTP confirm round-trip) and the Playwright e2e (e2e_serve.py always uses it; no real LLM in CI). 741 server tests (95.71% branch cov), 1498 web unit tests, 35 e2e.
- **Live smoke (real haiku harness, Max login)**: retrieval turn made a real search tool call; confirm-gated save_note round-trip landed the page. Found+fixed the critical ToolSearch deferral bug this way.
- **Docs** — SECURITY.md threat-model addendum; deploy/README.md prerequisites (SDK bundles its own claude binary; needs logged-in subscription; no ANTHROPIC_API_KEY in service env).

Follow-up: [[pkm-c98s]] (conversation lifecycle hardening: orphan 409 lockout, harness interrupt, Stop button, ApiError detail, preview truncation).
