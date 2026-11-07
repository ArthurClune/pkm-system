---
# pkm-gks1
title: 'Journal: a load error never clears, and a failed resync reload makes Load older days collapse to five days (make paging an explicit reducer)'
status: todo
type: bug
priority: low
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:46Z
updated_at: 2026-11-07T18:42:46Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding webui F4. Verdict: HOLDS (error) / HOLDS-NARROWER
(collapse: needs a server error, since network failures fall back to the
replica shim). A gap in the completed pkm-wstt.

- `views/Journal.tsx` sets `error` and never clears it; a later successful
  load leaves the red error under a working journal.
- `reset` empties `daysRef` but keeps the rendered `days`, and `loadMore`
  zeroes `windowRef` before its await. If that head load fails, "Load older
  days" has no cursor, loads the newest 5 and replaces the 20 on screen.

## Fix
Replace the loose paging state in `views/Journal.tsx` with one pure reducer
in its own Functional Core file. That state is `days`, `daysRef`,
`windowRef`, `loadingRef`, `genRef`, `done`, `error` and `loading`.
- States: `initial` / `loading(kind: head|older|reload, gen)` /
  `ready(days, cursor, window, done)` / `failed(previous ready, message)`.
- A reload keeps the previous `ready` (cursor and window) until its result
  lands. A failed reload returns to that `ready`, with the error shown on it.
- Any successful load clears the error.
- Results tagged with an old generation are ignored.

- [ ] Red tests: error then success; failed reload then Load older days
- [ ] Reducer plus shell; the component dispatches events and runs fetches

## Property testing (required)

This bean introduces or changes a state machine, so it gets full property
testing, not only unit tests (Arthur, 2026-11-07). Per
docs/architecture/checks.md § Property gate:

- Write the model from the docs (sync-and-offline.md, backend.md,
  assistant.md, frontend-editor.md as relevant), never from the code under test.
- The generator draws the whole event alphabet below, freely interleaved, and
  must reach the interleaving that found this bug.
- Show it reaches: label each named path with `event()` (server) or the
  suite tally (web) and read the rates from a real run.
- Show it has teeth: reintroduce this bug as a mutant (or a teeth route) and
  confirm the named invariant fails; a clean run passes.
- Run `proptest/check.sh` before merge; a red-first unit test for the
  original sequence goes beside the code as usual.

Sketch (fast-check, a new suite `web/src/props/journal`, reducer-level):
- Model from frontend.md (Journal): the journal shows a contiguous run of
  days ending today. "Load older days" extends that run backwards and never
  replaces it. An error is shown only while the most recent load has failed.
- Alphabet, freely interleaved:
  - `mount`, `loadOlder`, `resyncReload`;
  - `resultOk(gen, days)`, `resultFail(gen, 5xx)`, plus stale-generation
    results;
  - `unmount`.
- Must reach:
  - resyncReload → resultFail → loadOlder → resultOk;
  - resultFail → resultOk.
- Invariants:
  - the days shown never shrink except on mount;
  - they stay contiguous and newest-first;
  - the error is non-null exactly when the latest completed load for the
    current generation failed;
  - a stale-generation result changes nothing.
- Teeth: zero the window before the reload's await (today's `loadMore`) and
  confirm the never-shrink invariant fails.
