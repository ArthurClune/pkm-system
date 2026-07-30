---
# pkm-8m94
title: CLI/MCP writes store headings as literal markdown
status: in-progress
type: bug
created_at: 2026-07-30T20:01:33Z
updated_at: 2026-07-30T20:01:33Z
---

Blocks written via the pkm CLI or MCP tools with '## Heading' text are stored verbatim with heading=NULL, so the page shows literal '## Heading' instead of a rendered heading.

Root cause: server/src/pkm/cli/build.py never emits a 'heading' field on content blocks. The only place it does is _Planner.creates (build.py:158-160), for a 'parent: "## Heading"' spec naming a heading that does not yet exist on the page. Every other created block stores its text verbatim.

The ops layer is not at fault: CreateOp.heading (ops_core.py:26) and SetHeadingOp (ops_core.py:61) both exist and validate 1-3.

Compounding it: render.py:39 renders a real heading AS '## text', so 'pkm get --uids' -> edit -> 'pkm save'/'pkm update' is a lossy round trip that silently demotes real headings to literal markdown. The CLI/MCP contracts never mention that headings can be set at all.

Reproduction (pure, no server):

    plan_save({'blocks': []}, 'P', None, '## Overview', False, uids)
    -> [{'op': 'create', 'text': '## Overview'}]   # no heading field

Design: docs/superpowers/specs/2026-07-30-cli-mcp-heading-writes-design.md
