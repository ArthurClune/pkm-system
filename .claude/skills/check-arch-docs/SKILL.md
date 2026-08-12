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

1. **Mechanical sweep** — bean ids outside symptom tables:

   ```bash
   grep -rnE 'pkm-[a-z0-9]{4}' docs/architecture/ \
     | grep -vE '\|\s*$' \
     | grep -vE 'superpowers/specs|pkm-specific|pkm-replica'
   ```

   The first exclusion drops `| Symptom | Cause | Ref |` rows — the one
   legitimate home for bean ids. The second drops the known non-bean matches:
   spec file paths, "pkm-specific", the `/pkm-replica.sqlite3` filename.
   Read every remaining match; the expected count is zero. A bean id in
   prose is a provenance tag — drop the tag, keep the sentence. If the
   sentence only exists to name the bean, it is an incident: move it to the
   doc's symptom table or delete it.

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
| `pkm-replica`, `pkm-specific`, other product uses of "pkm-" | not bean ids; extend the grep exclusions if a new one appears |
| A "Known gap" paragraph describing a current, deliberate gap | the gap is an invariant; only the bean tag on it was provenance |
