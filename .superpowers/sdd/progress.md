# SDD progress: keyboard-shortcut beans batch 2026-07-16

(Previous ledger: pkm-c1cg epic, fully complete and merged — superseded.)

Base: 94d7009 (main) — all three branches start here
Beans / branches / worktrees / E2E ports:
- pkm-hx2w Shift-Cmd-Up/Down subtree move — feat/pkm-hx2w-subtree-move-shortcuts — .worktrees/pkm-hx2w — E2E_PORT 8981
- pkm-wquz Cmd-Enter TODO cycle — feat/pkm-wquz-todo-cycle-shortcut — .worktrees/pkm-wquz — E2E_PORT 8982
- pkm-smft search shift-open in sidebar — feat/pkm-smft-search-shift-sidebar — .worktrees/pkm-smft — E2E_PORT 8983

Briefs in scratchpad (/private/tmp/claude-501/-Users-arthur-code-llm-pkm/048b8857-da30-43d3-a0f3-f2f5d0e15233/scratchpad): task-{hx2w,wquz,smft}-brief.md; reports task-{id}-report.md alongside.
Plan: parallel implementers (sonnet), task review each (spec+quality), fix loops,
then sequential --no-ff merges into main with full verify between, push, final
combined review of 94d7009..main.

Status:
- pkm-hx2w: complete (commits 711df19 + fix e5030da on feat/pkm-hx2w-subtree-move-shortcuts, re-review clean; spec ✅, quality Approved). Collapsed-destination set_collapsed fix verified, shiftFrom coverage added. Note for final review: expanded-case DOM focus survival relies on reparent-not-remount (matches Alt-Arrow; low risk, no DOM-level test). NOT yet merged.
- pkm-wquz: complete (commits 56721b5 + fix 40350b2 on feat/pkm-wquz-todo-cycle-shortcut, re-review clean; spec ✅, quality Approved). Redesigned as key-edit through the draft pipeline (onCycleTodo removed). Minor for final-review triage: caret-delta formula would over-shift a caret sitting inside the `> ` quote-prefix literal (positions 0-1) — untested, unlikely. NOT yet merged.

Merge phase: DONE. smft (7eb646e) + hx2w (0995b56) merged, full verify exit 0; wquz merged clean (no conflicts), full verify exit 0. Note: unrelated commit 02b2322 (pkm-srek PDF-viewer design spec, another session) landed on main mid-batch and is inside the 94d7009..HEAD range — exclude from batch judgment. Next: push, final combined review, Minor triage, deploy decision.
- pkm-smft: complete (commit f5be50f on feat/pkm-smft-search-shift-sidebar, review clean; spec ✅, quality Approved). Minor findings for final-review triage: (1) new tests assert via openInSidebar spy + no-navigation, not cancel()'s blur effect (matches pre-existing style); (2) positional boolean go(row, shiftKey) vs options object (brief allowed either). NOT yet merged.
