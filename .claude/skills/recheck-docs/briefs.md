# Briefs for a re-check

Fill the `<…>` slots. Every brief ends with the same mechanics:

> Do the work yourself: no subagents, no forks, and do not claim or update
> tasks in the task list. Write your full report with a heredoc
> (`cat > <report path> <<'EOF'`); DONE without the report file is not DONE.
> Reply with only the counts per category and the report path, plus one
> line if something blocked you.

Report paths go in the session scratchpad: `review-<area>.md`,
`fix-<area>.md`, `final-<side>.md`.

## Reviewer (read-only)

> You are reviewing docs in /Users/arthur/code/llm/pkm. READ ONLY: do not
> edit, commit or create branches anywhere.
>
> Your scope: <files>. The other docs are <the rest of docs/ and
> docs/architecture/>; skim their headings only to judge duplication and
> ownership.
>
> First read `.claude/skills/architecture-docs/SKILL.md` in full and judge
> against it. The governing rule: a doc states what the code and its checks
> cannot tell a reader (orientation, why a rule exists, which of two paths is
> authoritative, invariants no type, lint or test enforces). Then read the
> "Where a fact belongs" table in `.claude/skills/recheck-docs/SKILL.md`.
> Code comments citing your docs by section: <hits from the sweep>.
>
> Audience: a senior dev getting up to speed, and an agent that needs to
> know what must not break. Report, per doc:
> 1. **Purpose** in one line, its words now (`wc -w`), and your estimate of
>    what it could be without losing a rule.
> 2. **Wrong claims**: anything the code contradicts. Open the code; a bean,
>    plan or the doc itself is not evidence. Check tables hardest (API rows,
>    route lists, config keys, commands, selectors, constants).
> 3. **Wrong home**: material another doc, AGENTS.md, a skill or the code
>    owns. Name both places and which keeps it.
> 4. **Bloat**: narration of readable code, case-by-case proofs, lists the
>    code holds, counts, incident stories outside troubleshooting, sections
>    placed in ship order rather than reader order.
> 5. **Broken pointers** check-docs cannot see: a link that lands on a
>    section that no longer states the thing; a code comment citing a section
>    that moved; a named file or symbol that no longer exists.
> 6. **Style**: a handful of representative long sentences, intensifiers or
>    bolded theses, with line numbers. Not exhaustive.
>
> Each finding: file, section, what a reader would get wrong, evidence (code
> path or quote), proposed fix. Most misleading first.

### Agents-and-memory reviewer: replace items 1–6 with

> For every fact in AGENTS.md and in each memory file
> (`~/.claude/projects/-Users-arthur-code-llm-pkm/memory/`, indexed by its
> `MEMORY.md`), give one verdict:
> - **keep**: true, and its home is right;
> - **stale**: the code, a command's `--help`, the filesystem or git
>   contradicts it (say what);
> - **already in the repo**: quote where; the memory copy goes;
> - **move**: it applies to any agent, not only Claude on this machine; name
>   the destination file and section;
> - **condense** or **merge**: say with what.
>
> Memory keeps only what is personal to Arthur or specific to Claude
> sessions on this machine. Check every identifier, path, port, command,
> skill and slash-command name a fact uses; open a named skill only to
> confirm it exists and says what the fact claims. Flag duplicates between
> memory files, and `MEMORY.md` hooks that no longer match their file. Edit
> nothing: memory has no git history to undo a stray change.

## Fixer (writes in the worktree)

> You are applying approved re-check findings. Worktree:
> <absolute worktree path>, branch <branch>. Run ALL commands from that
> path; NEVER touch /Users/arthur/code/llm/pkm directly. Run `pwd` and
> `git status -sb` before your first write. Edit only <files>. Stage by
> path, never `git add -A` (`web/node_modules` is an untracked symlink).
>
> Read `.claude/skills/architecture-docs/SKILL.md`, then the review report
> <path> and Arthur's rulings: <rulings>. Before applying each finding,
> verify it against the code; if the code disagrees with the reviewer, skip
> it and say why.
>
> For each paragraph, table row and diagram you touch, ask in order:
> 1. Would someone changing this code break something without it, and could
>    they not learn it from the code, a type or a test name? If they could,
>    cut it, keeping the identifiers.
> 2. Does another doc own this mechanism? Cut here; link there if a reader
>    needs the pointer.
> 3. Is it a sequence, a state machine or a branch? A diagram or decision
>    table replaces the prose.
> 4. Is it how something used to fail? It belongs in troubleshooting, once.
> 5. Is it a proof? Keep the invariant and its sharpest reason.
>
> Run check-docs on every file you touched, read its dropped-identifier list
> and make sure each drop is safe, and fix inbound links and code-comment
> citations to any heading you renamed or removed. Commit with a message
> whose first line contains "re-check" and whose body separates corrected,
> restructured and moved. Report: before/after words per file, each finding
> applied or skipped (why), dropped identifiers, and cuts you were unsure
> of.

## Final reviewer (read-only, adversarial)

> You are the final adversarial reviewer for a docs branch. READ ONLY.
> Worktree <path>, branch <branch>. The old docs are at <start SHA>: read
> them with `git show <sha>:<path>`.
>
> The branch cut and corrected docs under the rule that a doc states what
> the code and its checks cannot tell a reader. Narration, proofs, lists that
> copy code, counts and second copies were cut on purpose: do not report
> those as losses or recommend restoring them. Material may have moved:
> grep all of `docs/`, `AGENTS.md` and `.claude/skills/` before calling
> anything lost.
>
> Scope: <server side | client side and troubleshooting>. Hunt, in order:
> 1. **Lost rules.** Old text stating a rule or its reason that (a) is in no
>    doc on the branch, (b) is not evident from reading the code it concerns
>    (open it), and (c) could be broken without a test failing. Quote it,
>    name the code, say what would break, and propose the one sentence to
>    restore and where.
> 2. **Lost incidents.** An old troubleshooting row whose incident no row
>    now finds; a merged row whose symptom no longer matches one of its
>    incidents.
> 3. **Wrong claims** the code contradicts, above all in tables rebuilt from
>    prose and in claims the fixers say they corrected.
> 4. **Misleading pointers**: a link that resolves to a section that no
>    longer states the thing; a code comment citing a moved section.
> 5. **Surviving style**: a few examples at most.
>
> Assume the cut lost something and try to find it, but grade honestly: a
> finding that fails test (b) or (c) is not a lost rule. Rank most severe
> first; each with file, what, evidence and proposed fix.
