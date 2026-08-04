---
name: architecture-docs
description: Use when creating, revising, reviewing or extending anything under docs/architecture/ — after a feature or fix changes the shape of the system, when a doc or section reads long, flat, repetitive or equally-weighted, when asked to clarify/tighten/restructure/split a section, or before adding a new section to an existing doc.
---

# Architecture docs

These docs serve a senior dev getting up to speed and an agent that needs to
know what must not break. Both are served by one habit: **prose is the fallback,
not the default.** If a diagram, a table, or a link to the doc that already owns
the material can carry it, that is the version that ships — and the prose it
replaces goes away rather than sitting beside it.

## When to use

Any edit under `docs/architecture/`, including the triggers in `CLAUDE.md`
§ Architecture docs; or when a section reads long, flat or repetitive, when
ideas and small asides feel equally weighted, or when you are about to split,
reflow or clarify a section.

Not for `docs/design.md`, specs, plans or beans — those are *where* rationale,
history and rejected alternatives belong.

## Choose the shape before writing

| When the material is | Use | Instead of |
|---|---|---|
| a sequence, or one path through several states or failures | a mermaid diagram | "first… then… if that fails…" |
| a set of things sharing fields (keys, routes, states, options, outcomes) | a table | a comma list inside a sentence |
| a decision with two or three outcomes | a table keyed by the condition | a paragraph per branch |
| already owned by another doc | a link to it | a restatement that will drift |

Ownership matters as much as shape: `docs/keyboard.md` owns the shortcut
surface, `backend.md` the API reference, `docs/design.md` the rationale. A
second copy in prose is worse than no copy, because it drifts silently.

**Prose earns its place** for what no shape carries: why a step exists, what
breaks without it, who owns a value, which of two paths is authoritative, what
must never be rejected. After adding a diagram or table, that is all the
surrounding text should be left saying — if it still walks the sequence, delete
it.

Draw it from the code, not from the prose being replaced. A retry loop drawn
around the wrong call is worse than the paragraph it replaced.

## Make emphasis scarce

When every paragraph opens with a bolded thesis, nothing is emphasised and a
reader cannot tell a load-bearing invariant from an aside. Keep roughly one
bolded claim per section — the one a reader must not miss — and let the rest be
ordinary sentences. Headings name a topic; they do not assert a thesis.

If a section resists this because it holds ten equally important things, that is
the signal it wanted a table.

## Separate the invariant from the incident

Prose states the **current** invariant, plus why it exists where someone could
break it without noticing. How it used to fail — bean ids, "it used to", "for
years", since-deleted flags — goes in one symptom → cause → ref table at the end
of the doc, keyed by **what someone would observe**. That is how the content is
queried, and it lets each invariant shrink to a sentence.

## Keep the names

Cutting removes what agents grep for: `CONSTANT_NAMES`, function and file names,
error strings, wire fields. Prefer losing a sentence of explanation to losing an
identifier — a name points into the code, a sentence copies it.

## Verify

```bash
node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/<file>.md
```

Every mermaid block parses under the project's own mermaid; links and heading
anchors resolve, including inbound anchors from sibling docs (a renamed heading
breaks those silently); identifiers dropped since `HEAD` are listed for
judgement. Docs-only commits need no test run. The commit message should say
what was **corrected** (a claim that was wrong) versus **restructured** (no
claim changed).

## Common mistakes

| Mistake | Looks like | Instead |
|---|---|---|
| Adding a diagram beside the prose it replaces | diagram lands, section barely shrinks | the diagram or the paragraph, not both |
| Restructuring instead of clarifying | four new headings over the same paragraphs | change the shape of the material, not its subdivisions |
| An enumeration inside a sentence | twelve shortcuts, comma-separated, with parenthetical caveats | a table — or a link to the doc that already has one |
| Propagating a local formatting tic | "gave it a bold lead like its siblings" | fix the pattern rather than conform to it |
| Trusting the bean or plan | doc describes intended behaviour | verify against the code; it is what shipped |
