---
# pkm-odsx
title: Tighten prose in README, deploy/README and top-level docs
status: completed
type: task
created_at: 2026-09-23T15:16:46Z
updated_at: 2026-09-23T15:16:46Z
---

Apply the worklog review checks to README.md, deploy/README.md and docs/*.md (excluding docs/superpowers and docs/architecture): cut extraneous detail and LLM-isms (X-not-Y contrasts, lesson closers, superlatives, hedges, em-dash asides), reduce length, keep every fact accurate against the code.

- [x] README.md and deploy/README.md
- [x] docs/cli.md and docs/keyboard.md (keyboard.md stays within the /help parser subset)
- [x] docs/design.md and docs/SECURITY.md
- [x] docs/troubleshooting.md
- [x] dated implementation reviews (findings and verdicts preserved)

## Summary of Changes

Ten files rewritten for plain prose: 18,491 → 16,842 words; flagged hedges and contrasts ("deliberately", "rather than", "by design", "load-bearing" and similar) 44 → 0; no em-dash asides added. design.md's web-client section became a table of rules linking to the architecture docs that own each mechanism, and its stale counts and bundle-budget figures were removed. Incident stories in SECURITY.md were cut to the rules they installed. The dated reviews keep every finding, severity and file:line reference.

Facts corrected against the code: default assistant model is glm when a z.ai key is set, else sonnet; `pnpm verify` also runs lint and the FCIS check; `shared/` holds title-syntax and parity fixtures as well as the ref grammar; README linked a nonexistent CLAUDE.md (now AGENTS.md); MCP tools are not one per CLI verb; `-D`/`-T` belong to `pkm update`, not `pkm get`; op types and write routes in design.md; diagrams render through beautiful-mermaid with strict stock mermaid as fallback; the throttle's path; the glm credential source; a broken link to the backend review; a restore command that could not render.

Added: update.sh's refusal outside `$PKM_HOME/app` (and `PKM_UPDATE_FORCE=1`), the 03:30 backup time, troubleshooting links from both READMEs, the `test-data/` directory in the layout.

Gaps found during the rewrite, then filled: Ctrl+Shift+O in keyboard.md; `pkm assets search|scan` and `upload --parent` in cli.md; troubleshooting rows for pkm-y3rr and pkm-mbcc (their stories were cut from SECURITY.md); overview.md no longer says every mutation goes through `POST /api/ops`; SECURITY.md names the upload allowlist (`ALLOWED_UPLOAD_MIME`, 415). The WebSocket auth claim was wrong: a probe against uvicorn 0.49 shows close-before-accept reaches a real client as an HTTP 403 handshake refusal, and code 4401 is visible only to Starlette's test client. SECURITY.md and backend.md § Auth now say so; the web client never checks 4401, so nothing depended on it.

Checks: architecture-docs checker resolves every link and anchor; its remaining bean-id failure (backend review quoting a code comment) predates this change. `pnpm vitest run src/help/` passes (25 tests).
