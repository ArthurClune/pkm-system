---
# pkm-wn2s
title: Embed an LLM assistant in the app (ask-my-PKM)
status: draft
type: feature
created_at: 2026-07-24T16:48:39Z
updated_at: 2026-07-24T16:48:39Z
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

## Dependencies

- [[pkm-roph]] CLI surface improvements are effectively model-downsizing work: exact search, query ref-expansion, resolved block refs, and self-sufficient --help all remove judgment calls the model currently papers over. The smarter the tool surface, the cheaper the model can be. Do pkm-roph first or alongside.

## Open questions

- [ ] Where does the assistant live in the UI (side panel? command palette? chat page)?
- [ ] Server-side proxy for API keys vs BYO-key?
- [ ] Read-only first release, or writes (with in-app confirm before batch apply)?
- [ ] Streaming + tool-call progress display in the web client
