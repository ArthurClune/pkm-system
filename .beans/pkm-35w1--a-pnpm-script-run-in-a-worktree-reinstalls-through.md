---
# pkm-35w1
title: A pnpm script run in a worktree reinstalls through the node_modules symlink and repoints the main checkout's packages
status: in-progress
type: bug
created_at: 2026-11-11T09:47:10Z
updated_at: 2026-11-11T09:47:10Z
parent: pkm-4gda
---

pnpm's verify-deps-before-run check keys its state on the project path. A worktree's web/node_modules is a symlink to the main checkout's, so any pnpm script run from a worktree looks out of date, pnpm installs through the link, and the main checkout's top-level package links are rewritten to go through that worktree's path. They keep working until that worktree is removed, then break: a build from any checkout silently drops the PDF worker (pdfjs-dist is publicly hoisted) and five PDF e2e specs fail with 'Couldn't render this PDF'. Fix: turn the check off in web/pnpm-workspace.yaml; dependency changes already call for an explicit pnpm install --frozen-lockfile (AGENTS.md).

- [x] verifyDepsBeforeRun: false in web/pnpm-workspace.yaml, shown to stop the relink across two worktrees
- [ ] AGENTS.md and troubleshooting row (on the docs branch)
