---
name: recheck-docs
description: Use when asked to re-check, audit or review the whole documentation set (docs/, AGENTS.md and the Claude memory files) for facts that are out of date, duplicated, bloated or in the wrong home, or after a long run of feature work has appended to the docs. For a single branch's doc diff, use check-arch-docs instead.
---

# Re-check docs and memories

The docs, AGENTS.md and the memory files are one system: each fact has one
home, and the code is the truth. A re-check finds facts that are wrong,
copied, or living in the wrong home, and moves each to its owner. It runs as
read-only review, then Arthur's decision, then fixes on a branch, then an
adversarial review of the cut.

**First invoke the `architecture-docs` skill.** It is the house style every
reviewer and fixer judges against. The briefs in [briefs.md](briefs.md) are
what subagents are told; this file sequences the run.

With an argument naming an area or file (`/recheck-docs sync`), run every
step for that scope only.

## Where a fact belongs

| The fact is | Its home |
|---|---|
| how the system is: orientation, an invariant, why a rule exists | the `docs/architecture/` doc that owns the mechanism |
| a failure that happened | one row in `docs/troubleshooting.md` |
| CLI syntax, for users | `docs/cli.md` |
| a shortcut or slash command, for users, with no rationale | `docs/keyboard.md` |
| the threat model | `docs/SECURITY.md` |
| prod layout, backups, restore | `deploy/README.md` |
| a workflow or testing rule any agent needs | `AGENTS.md` |
| a tool recipe | the skill that owns the tool |
| a list the code already holds | the code; the doc names the symbol |
| Arthur's preferences and rulings, recipes for this machine, Claude Code mechanics | memory |
| history: finished work, old deployments, how a fix was found | git and the beans; nowhere else |

Memory lives at `~/.claude/projects/-Users-arthur-code-llm-pkm/memory/`,
outside git, indexed by its `MEMORY.md`.

## The run

1. **Set up.** Make a worktree and branch `docs/recheck-<date>`. Record the
   start SHA and `wc -w` of every doc. Find the last re-check with
   `git log --oneline -i --grep='re-check' -- docs AGENTS.md`; on a first
   run there is none, and the start SHA stands in for it. A re-check gets no
   bean; a code bug it uncovers gets its own.

2. **Mechanical sweep**, inline, before any agent starts:
   - `node .claude/skills/architecture-docs/check-docs.mjs docs/*.md docs/architecture/*.md`
     (in a worktree, symlink `web/node_modules` first and remove it before
     staging);
   - `PYTHONPATH=server/tooling python3 -m commentlint.run --all`;
   - code and comments that cite a doc by name, which check-docs cannot see.
     Hand each hit to the reviewer of the doc it cites:

     ```bash
     names=$(git ls-files 'docs/*.md' | grep -v superpowers | xargs -n1 basename | sed 's/\.md$//' | paste -sd'|' -)
     git grep -nE "($names)\.md" -- server web perf proptest deploy .githooks
     ```

   - `grep -rn 'load-bearing'` over `docs/`, `AGENTS.md`, `.claude/skills/`
     and the memory directory;
   - in memory: every `[[name]]` matches a file's `name:`, and `MEMORY.md`
     lists every file once.

3. **Fan out read-only reviewers**, in parallel, on sonnet, one per area,
   each with the reviewer brief from [briefs.md](briefs.md):

   | Reviewer | Scope |
   |---|---|
   | backend | `backend.md` |
   | sync | the `sync-*` docs and `sqlite-wasm-patch.md` |
   | frontend | `frontend*.md` and `styling.md` |
   | rest | every other doc in `docs/architecture/`, `overview.md` first |
   | troubleshooting | `docs/troubleshooting.md` |
   | user docs | `docs/cli.md`, `docs/keyboard.md`, `docs/SECURITY.md`, `README.md`, `deploy/README.md` |
   | agents and memory | `AGENTS.md`, the memory directory, and the skills they point to |

   A doc that fits no row goes to the nearest one. When reviewers disagree
   about where a fact lives, settle it by the table above before Arthur sees
   it: the doc that owns the mechanism keeps the fact.

4. **Report to Arthur and stop.** Spot-check the top findings against the
   code yourself first. Lead with the big picture: a table of each doc's
   one-line purpose, its words now, and what reviewers think it could be.
   Then the findings by category, most misleading first, and the decisions
   only Arthur can make, including, per doc, corrections only or a rewrite.
   Make no cuts until he answers.

5. **Fix on the branch.** Brief one sonnet fixer per set of files no other
   fixer touches, with the fixer brief; each commits its own work. If Arthur
   chose a rewrite for any doc, pilot one rewrite and show him its depth
   before the others start. Memory is not in git, so copy the directory to
   the scratchpad first. After the repo side lands, edit the memory files
   yourself, deleting each fact the repo now holds.

6. **Adversarial final review**, whenever a doc was rewritten: two
   reviewers on the strongest model, one for the server-side docs and one
   for the client side and troubleshooting, each with the final-review
   brief. A fixer then applies their findings, verifying each against the
   code first.

7. **Finish.** check-docs and commentlint pass. Commit messages say what was
   corrected (a claim was wrong), restructured (no claim changed) and moved
   (with its destination); the first line contains "re-check", so the next
   run finds it. Merge with `--no-ff`, remove the worktree, and push only
   when Arthur says to.

## The report to Arthur at the end

In order: the branch and merge commit; a before/after word-count table; one
bullet per finding fixed, the one most likely to have misled a reader first
(**short title**, the doc, what a reader would have got wrong, the fix);
each memory file changed or deleted, with what moved to the repo and where
(memory has no git history, so this list is its only review); and one
sentence for anything left undecided.

With no findings and a clean sweep, the whole message is "No drift since
`<last re-check sha>`."

## Not a finding

| Match | Why it stays |
|---|---|
| A bean id in troubleshooting's Ref column, or in a linked spec filename | those are its homes |
| `node_type`, `originSessionId` or `modified` in a memory's frontmatter | the memory tooling writes them |
| A ruling on the don't-re-propose list in the `pkm-standing-rulings` memory | Arthur already decided |
| A cut catalogue, count or proof walk from an earlier re-check | cut on purpose; recommending it back is the finding to avoid |
| A "Known gap" paragraph describing a current, deliberate gap | the gap is an invariant |
| A spec or plan under `docs/superpowers/` describing shipped work | specs and plans are committed as the rationale record; they are out of scope |

## Common mistakes

| Mistake | Instead |
|---|---|
| Calling material lost when it moved | grep all of `docs/`, `AGENTS.md` and the skills before reporting a loss |
| Trusting a bean, plan or the doc itself | open the code; it is what shipped |
| Renaming or cutting a heading that code comments cite | the step-2 grep lists those citations; fix them in the same commit |
| A reviewer or fixer spawning its own agents, or claiming tasks from the task list | every brief says: do the work yourself, and leave the task list alone |
| Moving a memory into the repo without checking it is still true | verify it against the code first; a stale fact moved is still stale |
| Hitting a word target by moving prose into mermaid labels | mermaid source counts; a target is a guide, the paragraph test decides |
| Writing a link or anchor checker | `check-docs.mjs` already resolves links and anchors, inbound ones too |
| Reviewers who edit, or fixes before Arthur has seen the findings | reviewers are read-only; step 4 is a stop |
