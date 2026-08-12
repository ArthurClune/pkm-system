---
name: check-arch-docs
description: Use when asked to re-check or audit docs/architecture/ for drift — inline bean references creeping back into prose, incident stories outside symptom tables, emphasis inflation — or before merging a branch that reworked those docs.
---

# Check architecture docs

Audits `docs/architecture/` for drift from the architecture-docs principles.
The recurring regression: a feature ships, its docs land, and inline
`(pkm-xxxx)` tags or incident prose ride along even though the ship session
had the skill loaded. This check catches that after the fact.

**First invoke the `architecture-docs` skill** — it defines the principles
this check enforces; this file only sequences the audit.

## The audit

1. **Mechanical sweep** — run the architecture-docs checker over every doc;
   its `checkBeans` fails on bean ids in prose, and its exclusions (table
   rows, linked spec filenames) live in the script, nowhere else:

   ```bash
   node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/*.md
   ```

   A flagged bean id is a provenance tag — drop the tag, keep the sentence.
   If the sentence only exists to name the bean, it is an incident: move it
   to the doc's symptom table or delete it.

2. **Judgment review** — find the last re-check
   (`git log --oneline --grep=re-check -i -- docs/architecture/`, or the
   docs-rebalance-emphasis merge `7d842de` failing that) and read
   `git diff <last>..HEAD -- docs/architecture/` against the skill's
   principles: incidents phrased as prose ("used to", "before the fix"),
   every paragraph opening with a bolded thesis, a new section appended at
   the bottom instead of where its subject sits, depth tracking ship effort
   rather than reader risk.

3. **Fix on a branch**, then run the skill's checker on each edited file:

   ```bash
   node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/<file>.md
   ```

4. **Commit** saying what was corrected versus restructured; no test run is
   needed for docs-only commits.

## What is not a violation

| Match | Why it stays |
|---|---|
| Bean id in a symptom table's Ref column | that column is its designated home |
| Bean id inside a linked spec/plan filename | filenames are identifiers, not provenance |
| `pkm-replica`, `pkm-specific`, other product uses of "pkm-" | not bean ids — the id shape ends at a word boundary, so they never match; a genuine new false positive means extending `checkBeans` in check-docs.mjs, not ignoring the failure |
| A "Known gap" paragraph describing a current, deliberate gap | the gap is an invariant; only the bean tag on it was provenance |
