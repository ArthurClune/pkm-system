---
description: Use when asked to update CHANGELOG.md with today's work
model: claude-opus-5-5
---

Update `CHANGELOG.md` at the repository root with today's work. Sources: beans and git commits on `main`.

The changelog records what changed, for a reader skimming months later. Beans and git hold the evidence; the entry says what a user or future maintainer would notice. Deploys, test and verification output, commit hashes, bean ids and titles, route names, internal thresholds and timeouts, how long something took, and how the work was done (worktrees, merges, test-first, subagents, which agent) are inputs you check the entry against. The entry records only the outcome.

Append a day entry at the end of the file:

- `## YYYY-MM-DD — theme`, where the theme is a flat noun phrase naming what shipped ("Date shortcuts, the file browser, and control styling"). Dates are in Europe/London time: `TZ=Europe/London git log main --date=format-local:%Y-%m-%d --pretty=%ad`.
- A single plain line when there was no product change ("No product change.").
- One bullet per thematic change, however many beans it took: "Property testing extended to the web sync stack." A short clause each.
- Bugs collapse into one bullet per area, naming the areas and not the mechanism: "Fixed bugs in title handling, file names containing parentheses, and CLI appends landing mid-list."
- Name an epic id inline when an epic closes.
- A commit that moves rules or lessons from agent memory into the repo (AGENTS.md, `docs/troubleshooting.md`, a skill) gets a bullet saying what moved and where.
- Repo housekeeping (symlinks, agent config, moving docs) gets none.

Match the tone and length of the entries for 2026-07-12, 2026-08-27, and 2026-10-01. Mechanism detail and lessons belong in beans, `docs/troubleshooting.md`, or memory.

Before saving, reread what you wrote and rewrite any sentence that:

- explains how a bug happened, or what a test, review, or harness found along the way;
- defines something by what it isn't ("X, not Y", "rather than", "instead of", "where it had");
- ranks the day against the period (most, busiest, largest); such claims go stale;
- closes on a moral or a "lesson worth keeping";
- leans on intensifiers or hedges: "deliberately", "actually", "merely", "genuinely", "by design", "load-bearing";
- uses an em-dash aside where a full stop or comma would do.
