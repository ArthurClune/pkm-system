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

Ownership matters as much as shape: `docs/keyboard.md` owns the shortcut surface
and the slash commands, `docs/cli.md` the CLI's user-facing syntax, `backend.md`
the API reference, `docs/design.md` the rationale. A second copy in prose is
worse than no copy, because it drifts silently.

**Dedupe toward the doc that owns the mechanism, not away from it.** When two
docs describe the same thing, the one whose subject implements it keeps the
sentence and the other links. Server broadcast behaviour stays in `backend.md`
even though the sync doc needs it too.

**Prose earns its place** for what no shape carries: why a step exists, what
breaks without it, who owns a value, which of two paths is authoritative, what
must never be rejected. After adding a diagram or table, that is all the
surrounding text should be left saying — if it still walks the sequence, delete
it.

Draw it from the code, not from the prose being replaced. A retry loop drawn
around the wrong call is worse than the paragraph it replaced.

## Write plain sentences

**One idea per sentence.** A sentence that needs a third comma-clause, an
em-dash aside and a colon to land is three sentences. This one is the failure to
watch for, because each clause is individually correct and the whole is
unreadable:

> `opQueue` treats a failed replica RPC as "could not persist locally right now",
> which is what it does with every local write failure, and retains the op unless
> the replica rejected the op itself. That rule is a one-item blocklist on
> `ReplicaError.rejected` — an op the server would refuse too, e.g. unsupported
> reference title syntax — and deliberately not a check on the availability type:
> a starved pool's `SQLITE_CANTOPEN` is neither `unusable` nor `unreachable`, so
> a type check would fall through to `onDesync`, whose authoritative repair wipes
> the active outline back to the edit-less server state and detaches the editor
> mid-keystroke.

Rewritten as one claim per sentence, in the order a reader needs them: what the
rule is, what it is not, why not, what the consequence would be.

Also:

- **Name things the way the code names them.** `ReplicaAvailability` has two
  values; it is not "the availability fact" with "evidentiary weight". Invented
  terms of art make a reader learn vocabulary that no grep will find.
- **Say the thing instead of introducing it.** "Two choices worth spelling out",
  "the subtlety is that", "two things invisible from the shapes" — delete the
  frame and keep the content.
- **Cut intensifiers.** "deliberately", "precisely", "definitively", "exactly
  this" rarely survive contact with a specific reason. Assert intent only where a
  reader would otherwise suspect a bug, and then give the reason.
- **Prefer the plain verb.** "X catches that" over "which is what X is for".

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
years", since-deleted flags — goes in the doc's `## When something looks wrong`
table, keyed by **what someone would observe**. That is how the content is
queried, and it lets each invariant shrink to a sentence.

`backend.md`, `frontend.md` and `sync-and-offline.md` each carry that section,
with the same heading and the same `| Symptom | Cause | Ref |` columns, placed
just before the closing section. Copy the one in `sync-and-offline.md`. `Ref` is
the bean id, or the test that pins the behaviour, or an em dash. `overview.md` has
no such section and should not gain one: it summarises the others rather than
owning any mechanism, so it has no failures of its own to record.

**The test for whether something is an incident:** does it describe a state of
the code that no longer exists, or a mechanism that is still true today? "Handlers
used to race the PRAGMA setup" is the first, and moves. "`send()` no-ops once the
client disconnects" is the second, and stays — even though both read like war
stories. Discovery context ("found in a live smoke test") does not make a
rationale into an incident.

Two more things are *not* incidents, and neither earns a row:

- **Provenance.** A bean tag marking which work introduced a feature, with no
  failure attached ("Block stamps (pkm-4ler) add three band tokens"), is not a
  symptom. Drop the tag or leave it inline; don't invent a symptom for it.
- **An incident already tabled in the doc that owns the mechanism.** One row, in
  one doc — the same rule as for facts. A second row elsewhere is a duplicate
  that will drift.

**Never manufacture rows.** Four honest rows beat eight padded ones, and a doc
with little history should end up with a short table.

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
breaks those silently). It also prints, for judgement rather than pass/fail, the
longest prose sentences and any identifiers dropped since `HEAD`.

**Re-run it after your edits and read the count, not just the list.** It shows
the longest five by default (`--all` for the rest), so clearing those five is not
the same as being done — splitting one sentence often lengthens another. Any 40+
word sentence your edit introduced is marked `NEW` and always listed, wherever it
ranks.

Docs-only commits need no test run. The commit message should say what was
**corrected** (a claim that was wrong) versus **restructured** (no claim
changed).

## Common mistakes

| Mistake | Looks like | Instead |
|---|---|---|
| Adding a diagram beside the prose it replaces | diagram lands, section barely shrinks | the diagram or the paragraph, not both |
| Restructuring instead of clarifying | four new headings over the same paragraphs | change the shape of the material, not its subdivisions |
| An enumeration inside a sentence | twelve shortcuts, comma-separated, with parenthetical caveats | a table — or a link to the doc that already has one |
| Stacking clauses onto a correct sentence | two subclauses, an em-dash aside and a colon, all accurate | one claim per sentence, in the order a reader needs them |
| Inventing a term of art | "the availability fact", "evidentiary weight" | the name the code uses |
| Propagating a local formatting tic | "gave it a bold lead like its siblings" | fix the pattern rather than conform to it |
| Trusting the bean or plan | doc describes intended behaviour | verify against the code; it is what shipped |
