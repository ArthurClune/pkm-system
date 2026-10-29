---
# pkm-oirq
title: Dependency upgrades and minimal harness environment
status: in-progress
type: task
priority: low
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-29T16:06:48Z
parent: pkm-mfd0
---

Review observations: pip-audit 27 advisories (pyjwt, cryptography, mcp, anyio, httpx2/httpcore2, certifi) and pnpm audit --prod 15 (dompurify via mermaid, mermaid, katex, react-router); none judged reachable, all cheap upgrades. The harness and pkm-mcp inherit the whole server env (OPENAI/GOODLINKS/z.ai keys, PKM_URL).

- [ ] Red test first, from the review probe: sec-assistant/drive_harness.py + envdump_mcp.py (real bundled CLI) and the sec-cross audit JSON. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] uv lock --upgrade-package for the advisories; mermaid >= 11.16.1 and dompurify >= 3.4.17
- [ ] Give the harness subprocess an explicit minimal environment
- [ ] pkm-mcp ignores PKM_URL when PKM_CLI_CONFIG is set
