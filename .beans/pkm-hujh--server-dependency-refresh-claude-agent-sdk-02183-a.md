---
# pkm-hujh
title: 'Server dependency refresh: claude-agent-sdk 0.2.183 and in-range bumps'
status: completed
type: task
priority: low
created_at: 2026-11-17T19:56:14Z
updated_at: 2026-11-17T21:02:28Z
---

claude-agent-sdk is at 0.2.168; 0.2.183 is out. Its bundled CLI maps the assistant's model aliases to model ids, so newer Claude models reach the assistant only through an SDK upgrade. The other server dependencies have in-range releases (fastapi, pydantic, uvicorn, python-multipart, starlette, pyrefly, pytest, hypothesis, ruff). pip-audit is clean before and must stay clean.

mcp 2 is done separately on this branch under pkm-cxq5. websockets 17 is a major and is only exercised through uvicorn's WS transport, which pytest does not reach, so it is held at 16 and goes to the deferred-majors bean.

- [x] claude-agent-sdk to 0.2.183
- [x] uv lock --upgrade within constraints, websockets held at 16
- [x] ruff 0.17 with the pre-0.17 default rules pinned in select (adopting the wider default is pkm-453b)
- [x] pip-audit clean
- [x] pytest, pyrefly, ruff green
- [x] Live assistant start against the new SDK: a sonnet conversation on a scratch server ran the search tool through pkm-mcp and named its model claude-sonnet-5-5

## Summary of Changes

claude-agent-sdk 0.2.168 to 0.2.183, plus in-range bumps (fastapi 0.162, starlette 1.10, pydantic 2.14, uvicorn 0.54, pyrefly 1.4, ruff 0.17, pytest, hypothesis). websockets is bounded <17 (pkm-tcca). pip-audit clean before and after.

ruff 0.17 widened its default rules (515 findings); `select` names the pre-0.17 default plus E501 and ANN, and pkm-453b carries adopting more.

starlette 1.10's FileResponse keeps a receive() pending throughout the send and cancels it on `http.disconnect`. Test fakes that returned from receive() at once (a body forever, or an immediate disconnect) hung the export temp-dir test's GET case at full CPU and tripped the body cap in its POST case; they now block as a connected client does. Production is unaffected: uvicorn's receive blocks.

Gates: pytest 6203 passed at 98% coverage; pyrefly and ruff clean; proptest server 10 passed; perf backend no changes. A live sonnet turn on a scratch server ran pkm-mcp's search tool and named its model claude-sonnet-5-5.
