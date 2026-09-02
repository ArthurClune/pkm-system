# Scenario J — Journal render churn per keystroke (pkm-qfee)

**Date:** 2026-09-02 · **before:** `d78853c` · **after:** `504b47d` (branch `worktree-perf-qfee`)

Same machine, same seeded server (`E2E_PORT=8977`, `seed.mjs`: 300-block "Perf Big Page" plus 30
daily pages × 10 blocks), headed Chromium, one run each — repeated runs are bit-identical, because
every headline number here is a structural count rather than a timing.

Scenario J: load `/`, scroll until the journal stops loading days (**31 mounted `EditablePage`s, 300
block rows**), then type 50 characters into the first block. React commits and re-rendered fibers are
counted through a minimal DevTools hook (`react-commits.js`).

## Result

| per keystroke | before | after |
|---|---|---|
| React commits | 1.10 | 1.12 |
| **fibers that re-rendered** | **94.4** | **3.4** |
| fibers visited by the walk | 332.4 | 104.2 |
| **worst single commit** | **2278** | **32** |

Totals over the 50 characters: 4720 → 172 re-rendered fibers (−96 %); 55 → 56 commits.

The worst commit is the interesting one. Before, the debounced flush moved `pending` 0 → 1 → 0, and
each move was a new Sync context identity: every one of the 31 mounted outlines rebuilt its handlers
and re-rendered all of its rows — 2278 fibers for an edit that changed one block's text. After, that
commit touches 32 fibers: the edited block and its own tree.

The steady per-keystroke figure (94.4 → 3.4) is the draft path. A keystroke only re-renders the
focused `BlockInput`; the residue was the tree above it re-rendering with a fresh `Set`, callback and
`Date.now()` per render, which `React.memo` plus stable props now absorbs.

## What did not improve

- **Commits are unchanged (55 → 56).** The number of state updates is the same; what changed is how
  much each one costs. Coalescing them is not this task's fix, and the extra commit here is one more
  `/api/sync/changes` pull landing inside the window.
- **DOM mutations are unchanged (50, none outside the focused block).** They already were the floor:
  React reconciled the wasted renders to no DOM writes, which is exactly why this scenario had to
  count fibers.
- **Layouts (50) and style recalcs (1) are unchanged**, for the same reason.
- **CPU 13.7 % → 12.2 %, task 0.32 s → 0.29 s.** Directionally right, but a single headed run with a
  fiber walk on every commit; not a number to quote.
- **An edit still re-renders every row of its own day.** `applyOps` deep-clones the tree, so every
  node object is new even where the text is not, and `React.memo` cannot help. Structural sharing in
  `outline/tree.ts` would fix that; it is a separate change (worth ~300 fibers per flush on a 300-row
  page, versus the ~2250 this task removed).
