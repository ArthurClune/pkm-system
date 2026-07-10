---
# pkm-d9o6
title: pyrefly check matches zero files in .claude/worktrees checkouts
status: completed
type: bug
priority: low
created_at: 2026-07-10T12:41:58Z
updated_at: 2026-07-10T13:21:06Z
---

Two subagents working in git worktrees under .claude/worktrees/ found that bare 'uv run pyrefly check' reports no Python files matched: the root pyrefly.toml's project-includes glob resolves oddly when the repo root has a dot-prefixed ancestor directory (reproduced with --use-ignore-files=false, so not gitignore-driven; does not reproduce in the main checkout). Workaround both used: pass explicit paths, e.g. 'uv run pyrefly check src tests' from server/. Fix pyrefly.toml (or document the workaround) so worktree-based parallel sessions can run the standard verify command.

## Summary of Changes

**Reproduced** in this worktree (`/Users/arthur/code/llm/pkm/.claude/worktrees/agent-a542a1cc82ecf6957`, itself under the dot-prefixed ancestor `.claude/worktrees/`): bare `uv run pyrefly check` from `server/` printed `No Python files matched pattern .../server` even with `--use-ignore-files=false`.

**Root cause (two independent mechanisms, both had to be defeated):**

1. **`.git/info/exclude` (shared across all worktrees via the common git dir) contains `**/.claude/worktrees/`**, added so `git status` in the main checkout doesn't show worktree contents as untracked. Because the pattern is anchored with a leading `**/`, pyrefly's ignore-file matching applies it against the absolute path too, and since every worktree's own root *is* `.../​.claude/worktrees/<name>`, the pattern matches the worktree's entire tree from inside itself — not just from the main checkout's point of view. This mechanism is controlled by pyrefly's `--use-ignore-files` / `use-ignore-files` setting.
2. **Pyrefly's default `project-excludes` heuristics auto-add the interpreter's site-package paths** (here: `server/.venv/lib/python3.12/site-packages` and the editable-install `server/src`) to the exclude list. Confirmed via upstream reports (facebook/pyrefly#2402, #1389) that pyrefly's project-discovery walker has (or historically had) a hidden-directory-related default-exclude heuristic that misfires when the project root itself sits under a dot-prefixed ancestor. This is controlled by `--disable-project-excludes-heuristics` / `disable-project-excludes-heuristics`.

Neither flag alone fixed it — `--use-ignore-files=false` alone still skipped the whole directory (mechanism 2 still active), and disabling only the excludes heuristics still skipped it (mechanism 1 still active via `.git/info/exclude`). Only disabling **both**, combined with an explicit, minimal `project-excludes` list (since disabling the heuristics also drops the default `**/node_modules`, `**/__pycache__`, `**/venv/**/*` globs and the auto site-packages/src excludes), fixed it. Confirmed via a from-scratch upstream-repo `git worktree add` reproduction (mirroring the exact `.claude/worktrees/<hash>/server` shape) that this really is path-shape-triggered, not something specific to this repo's content.

**Fix**: added to `pyrefly.toml`:
```toml
disable-project-excludes-heuristics = true
project-excludes = ["**/node_modules", "**/__pycache__", "**/.venv/**/*"]
use-ignore-files = false
```
(note `.venv` with the dot, matching this repo's actual venv directory name — the old default `**/venv/**/*` never matched it anyway).

**Verification**:
- Worktree, bare `uv run pyrefly check` from `server/`: `Checking 87 files` → `0 errors (2 suppressed)`.
- Same worktree, `uv run pyrefly check src tests` (the old workaround): `Checking 87 files` → `0 errors (2 suppressed)` — identical count, confirms parity.
- Main checkout (`/Users/arthur/code/llm/pkm`), same config: also `Checking 87 files` → `0 errors (2 suppressed)` — no regression there (previously bare check there covered only `tests/` as "first-party", with `src/` treated as an installed dependency via project-excludes; now both are checked directly as project files, matching the documented workaround's behavior exactly).
- `uv run pytest -q` in the worktree: `280 passed`.
- `uv run ruff check` in the worktree: `All checks passed!`
- Main checkout's working tree is untouched/clean (verified via `git status` before and after).

Filed as a config workaround for a genuine upstream pyrefly limitation (dot-prefixed ancestor directories confusing both its ignore-file matching and its default project-excludes heuristics) — no pyrefly.toml-only fix exists that doesn't route through these two flags.
