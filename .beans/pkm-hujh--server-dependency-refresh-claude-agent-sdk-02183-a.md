---
# pkm-hujh
title: 'Server dependency refresh: claude-agent-sdk 0.2.183 and in-range bumps'
status: in-progress
type: task
priority: low
created_at: 2026-11-17T19:56:14Z
updated_at: 2026-11-17T20:33:32Z
---

claude-agent-sdk is at 0.2.168; 0.2.183 is out. Its bundled CLI maps the assistant's model aliases to model ids, so newer Claude models reach the assistant only through an SDK upgrade. The other server dependencies have in-range releases (fastapi, pydantic, uvicorn, python-multipart, starlette, pyrefly, pytest, hypothesis, ruff). pip-audit is clean before and must stay clean.

mcp 2 is done separately on this branch under pkm-cxq5. websockets 17 is a major and is only exercised through uvicorn's WS transport, which pytest does not reach, so it is held at 16 and goes to the deferred-majors bean.

- [x] claude-agent-sdk to 0.2.183
- [x] uv lock --upgrade within constraints, websockets held at 16
- [x] ruff 0.17 with the pre-0.17 default rules pinned in select (adopting the wider default is pkm-453b)
- [x] pip-audit clean
- [ ] pytest, pyrefly, ruff green
- [x] Live assistant start against the new SDK: a sonnet conversation on a scratch server ran the search tool through pkm-mcp and named its model claude-sonnet-5-5
