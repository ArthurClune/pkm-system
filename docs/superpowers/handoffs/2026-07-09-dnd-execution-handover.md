# Handover: execute the block drag-and-drop plan

**Date:** 2026-07-09 (evening)
**Branch:** main at `2e7dd2f`, clean, pushed.

## Where we are

Brainstorm → spec → plan for **block drag-and-drop (bean pkm-jg1p)** is done
and approved. Nothing of the feature is implemented yet.

- **Spec:** `docs/superpowers/specs/2026-07-09-block-drag-and-drop-design.md`
- **Plan:** `docs/superpowers/plans/2026-07-09-block-drag-and-drop.md`
  (9 tasks, TDD, complete code in every step)

## Next action

Execute the plan, task 1 onward. The user was offered subagent-driven
(recommended) vs inline execution and had not yet chosen when this handover
was written — **ask which, then use superpowers:subagent-driven-development
or superpowers:executing-plans accordingly.** Consider a worktree
(superpowers:using-git-worktrees) as the plans before this one did.

Key facts an executor needs (all verified this session, in the plan too):

- The server currently **rejects** cross-page moves (`ops_core.py` move
  branch); the plan removes that guard and adds `MoveOp.page_title` +
  a `SetPageId` effect.
- `blocks_fts` indexes block text only (content='blocks', no page column) —
  cross-page moves need **no FTS reindexing**. Search joins pages at query
  time (verified via `test_cross_page_move_subtree_and_backlinks_survive`
  expectations in the plan).
- `MoveOp.order_idx` contract: "insert before the block currently at
  order_idx, counted BEFORE the moved block is removed"; order values are
  read off trees, never array positions (server leaves gaps).
- After changing any Pydantic op model: regenerate
  `web/src/api/openapi.json` (`uv run python -m pkm.server.openapi_dump`)
  and `pnpm gen-types`, or `server/tests/test_openapi_sync.py` fails.
- HTML5 quirk the design leans on: `dataTransfer` payload is unreadable
  during `dragover`, so the active drag lives in a React `DndContext`.

## Session context worth keeping

- **Run `beans prime` at session start** (CLAUDE.md). Beans live in
  `.beans/` in THIS repo (initialized today).
- **Deployment footgun (bit us today):** `deploy/update.sh` updates the
  checkout the script LIVES IN. The production app is
  `~/.config/pkm/app` — run `~/.config/pkm/app/deploy/update.sh`, never the
  dev checkout's copy. Bean **pkm-r1wy** tracks hardening this (guard +
  `cache-control: no-cache` on index.html). `deploy/smoke.sh` prompts
  interactively for the app password — only its pre-auth checks run
  unattended.
- Journal block-ref bug (pkm-862c) is fixed AND deployed; the fix pattern
  (`/api/journal` returns `block_ref_texts`; Journal provides
  `BlockRefContext`, merging across batches) is a useful reference for any
  view that renders blocks outside `/api/page`.

## Open beans (after pkm-jg1p)

| Bean | What |
|---|---|
| pkm-bz6n | Keyboard shortcuts: Ctrl-Cmd-D → home, Cmd-U search (replacing Cmd-K; current binding in `App.tsx`) |
| pkm-as55 | Import sidebar entries — the 22 titles are IN the bean body; no API fetch needed |
| pkm-j5n6 | Slash commands in the editor (/text, /python, …) |
| pkm-g356 | Editable sidebar panels (follow-on from DnD; panels are read-only refetch-based drop targets in the plan) |
| pkm-r1wy | update.sh wrong-checkout guard + index.html no-cache |

All of these still need the full brainstorm → spec → plan cycle except
pkm-r1wy (small enough to design inline) and pkm-as55 (data is ready; needs
a decision on where sidebar entries live — likely config or a pinned-pages
table — which is exactly what brainstorming should settle).

## Verification habits this project expects

- TDD everywhere; run `cd server && uv run pytest` and
  `cd web && pnpm vitest run && pnpm typecheck` before claiming a task done.
- Real-data smokes use a scratch DB copied via the SQLite backup API from a
  `mode=ro` connection — the live `data/pkm.sqlite3` is never opened for
  writing; record pre/post page+block counts (see plan task 9).
- Commit bean files with the code they relate to; always `git push` after
  committing; `--no-ff` when merging branches.
