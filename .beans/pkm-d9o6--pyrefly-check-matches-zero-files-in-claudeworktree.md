---
# pkm-d9o6
title: pyrefly check matches zero files in .claude/worktrees checkouts
status: todo
type: bug
priority: low
created_at: 2026-07-10T12:41:58Z
updated_at: 2026-07-10T12:41:58Z
---

Two subagents working in git worktrees under .claude/worktrees/ found that bare 'uv run pyrefly check' reports no Python files matched: the root pyrefly.toml's project-includes glob resolves oddly when the repo root has a dot-prefixed ancestor directory (reproduced with --use-ignore-files=false, so not gitignore-driven; does not reproduce in the main checkout). Workaround both used: pass explicit paths, e.g. 'uv run pyrefly check src tests' from server/. Fix pyrefly.toml (or document the workaround) so worktree-based parallel sessions can run the standard verify command.
