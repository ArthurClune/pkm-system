---
# pkm-oirq
title: Dependency upgrades and minimal harness environment
status: completed
type: task
priority: low
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-29T18:02:39Z
parent: pkm-mfd0
---

Review observations: pip-audit 27 advisories (pyjwt, cryptography, mcp, anyio, httpx2/httpcore2, certifi) and pnpm audit --prod 15 (dompurify via mermaid, mermaid, katex, react-router); none judged reachable, all cheap upgrades. The harness and pkm-mcp inherit the whole server env (OPENAI/GOODLINKS/z.ai keys, PKM_URL).

- [x] Red test first, from the review probe: sec-assistant/drive_harness.py + envdump_mcp.py (real bundled CLI) and the sec-cross audit JSON. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [x] uv lock --upgrade-package for the advisories; mermaid >= 11.16.1 and dompurify >= 3.4.17
- [x] Give the harness subprocess an explicit minimal environment
- [x] pkm-mcp ignores PKM_URL when PKM_CLI_CONFIG is set


## Summary of Changes

**Harness environment.** The harness CLI now starts through a Python launcher that calls os.execve with an allow-listed environment (HOST_ENV, SDK_ENV and the harness env). The launcher's shebang is `-IS`, so PYTHON* variables and .pth files cannot redirect it; it resets SIGPIPE and SIGXFSZ to their defaults before the exec and is written as UTF-8 whatever the locale. This replaced an `env -i` shell launcher, which kept the session token out of argv only awkwardly and had shell quoting to get right. pkm-mcp runs under `env -i` with only PKM_CLI_CONFIG. A CLI path that env would parse as an assignment is refused. The credential file and the launcher file are removed on every path, including a failed write. The red spawn test showed the leak of server environment variables to the child; it is green now. A live start with the real bundled CLI answered a search question through pkm-mcp, and the child environments held only allow-listed names.

**pkm-mcp.** load_mcp_config ignores PKM_URL when PKM_CLI_CONFIG names the config. The CLI keeps PKM_URL.

**Python upgrades.** pip-audit advisories went from 31 in 7 packages to 0 (pyjwt, cryptography, mcp, anyio, httpx2, httpcore2, certifi). mcp is bounded `<2`.

**Web upgrades.** pnpm audit --prod advisories went from 15 to 2. mermaid is pinned `~11.16.1` so a minor bump forces the mirror re-check; dompurify is 3.4.17 and katex 0.18.10. The mermaidSafety rules were re-checked against the new mermaid and dompurify and all hold, and katex 0.18 still refuses links and images. The two remaining advisories are react-router v6 ones, judged unreachable (see the follow-up bean).

**Docs.** docs/architecture/assistant.md (the harness environment allow-list and the Auth row's token claim), docs/cli.md, docs/troubleshooting.md, and deploy/README.md (which variables reach the harness; proxy, CA-cert and operator CLAUDE_CODE_* variables no longer do).

**Rulings.**
- react-router v6 advisories accepted as unreachable here; a low bean carries the v7 move. Cost if wrong: one more upgrade branch.
- mcp bounded `<2`; a low bean carries the 2.x move. Cost: none now.
- mermaid pinned `~11.16.1` so minor bumps force the mirror re-check. Cost: manual bumps.
- The `=` guard on the CLI path was added before review, as it is the same hazard as the interpreter guard.
- Python launcher over `env -i` shell: simpler, no quoting, token out of argv. Cost: tens of ms of startup per conversation.
- Launcher flags `-IS`, signal reset and UTF-8 writes taken in the fix wave, since each is cheap and fail-closed.
- The live start ran after the fix wave so it exercised the shipped launcher.
- No property gate: nothing in sync, ops, titles, planning, outline commands or undo changed.
- Third-party test warnings (starlette BlockingPortal, an intermittent pydantic alias) left alone.
