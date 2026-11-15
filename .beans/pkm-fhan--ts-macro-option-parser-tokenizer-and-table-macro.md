---
# pkm-fhan
title: TS macro option parser, tokenizer and table macro
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T17:21:46Z
parent: pkm-l79g
---

Task 4 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.


## Summary of Changes

- `web/src/grammar/macroOptions.ts` (Core): `splitMacroOptions`, `formatMacroOptions`, `normaliseMacroOptions`, `optionsRefusal`, `rewriteMacroOptions`, `tableMacroOptions`. Mirrors `server/src/pkm/macro_options.py`: Python's strip whitespace set and Python `repr()` in refusal messages, so both sides read and refuse alike. `macroOptions.test.ts` replays both sections of `shared/fixtures/macro_options_parity.json`; `macroOptions.props.test.ts` is the round-trip property on the server property's alphabet.
- Tokenizer: the query segment is `{ kind: "query"; expr; options; span }`; `expr` excludes options and `span` covers the whole macro. The body goes to the split untrimmed, as the server's export does. `QueryBlock` therefore sends the bare expression to `/api/query`.
- `roamTable(node)` returns rows and the macro's options; `roamTableRows` wraps it. A table macro may carry ` | name: value` options (`{{table | sort: Lab desc}}`).
- Props model `isMacro` and its generators accept options; the contract rows in `docs/architecture/contracts/frontend-editor.md` say so.
- `initialEntryBytes` rebaselined: the parser sits in the entry with the tokenizer.
