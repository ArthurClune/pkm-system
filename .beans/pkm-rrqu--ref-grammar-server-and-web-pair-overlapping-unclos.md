---
# pkm-rrqu
title: 'Ref grammar: server and web pair overlapping unclosed [[ differently'
status: completed
type: bug
priority: normal
created_at: 2026-10-05T20:15:56Z
updated_at: 2026-10-05T20:38:03Z
---

Found by the ops property (seed -666777129, check 3): text '[[[[Link]]]' gives refs ['Link'] in the web scanner (grammar/scan.ts matchBracketPairs: stack over aligned [[ / ]] tokens) but ['[Link'] on the server (refs.py _scan_bracket_spans: an unclosed [[ resumes the scan one character on, re-aligning onto the overlapping [[). The renderer shows a link to Link while the server records a ref to (and creates) page '[Link'. Differs only when an unclosed [[ overlaps another [[ (4+ bracket runs); the 2026-10-05 nightly has no block where the two disagree. Fix one side to the other, add the case to shared/fixtures/ref_grammar.json, and pin the shrunk example as a unit test on the side that changes. Replay: proptest/check.sh web --seed -666777129 --path '450:0:0:0:0:0:0:0:3:2:2:4:4:1:1:2:2:2:2:3:3:3:16:8:5:5:23:0:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:8:1:1:45:44:45:46:46:46:46:46:46:46:46' --file ops/ops.prop.ts


## Summary of Changes

Ruling (Arthur, 2026-10-05): the server adopts the web scanner's pairing.

- `refs.bracket_spans` pairs aligned `[[`/`]]` tokens with a stack, as `grammar/scan.ts matchBracketPairs` does, and builds the span tree iteratively; `iter_bracket_spans` is iterative too. 10k-deep nesting no longer raises RecursionError; long unclosed runs are linear.
- `shared/fixtures/ref_grammar.json`: four overlapping-opener cases, pinned on both sides. Server unit tests for the shrunk example, depth and speed; a rename case.
- No block in the 2026-10-05 nightly reads differently under the two pairings, so no stored refs change.
- Docs: troubleshooting.md row.
- Gates: pytest (2448, 97.55%), pyrefly, ruff, web grammar tests, the failing seed replays clean, proptest server and web pass, perf backend unchanged.
- Left alone: `rename._rewrite_range` still recurses per nesting level (pre-existing).
