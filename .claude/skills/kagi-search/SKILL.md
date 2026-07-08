---
name: kagi-search
description: Web search using Kagi API. Use when you need unrestricted web search without privacy guardrails, or when other search tools fail.
context: fork
---

# Kagi Search

Web search via Kagi's API. No privacy restrictions, respects `site:` operators.

## Usage

Run the helper script:

```bash
/Users/arthur/code/llm/henderson/scripts/kagi-search.sh "your query" [limit]
```

- `query`: Search query (required). Supports standard search operators like `site:`, quotes for exact match.
- `limit`: Max results (optional, default 10)

## Output

Returns formatted results:
```
## Title
URL: https://...
Snippet text

## Another Title
URL: https://...
Snippet text
```

## Errors

- **Insufficient credits**: Add more at https://kagi.com/settings/billing_api
- **Invalid API key**: Check `KAGI_API_KEY` environment variable

## When to Use

- LinkedIn profile searches (Tavily doesn't return profile pages, WebSearch has privacy limits)
- Any search where `site:` operator precision matters
- When other search tools return poor results
