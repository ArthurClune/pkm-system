---
# pkm-9qgk
title: Hex-colour pages minted from inside nested code fences
status: completed
type: bug
priority: normal
created_at: 2026-08-13T18:34:53Z
updated_at: 2026-08-13T18:49:35Z
---

Pages like '0277bd', 'ffcdd2' are being auto-created. They are hex colours (#0277bd) from inside fenced code (Mermaid diagrams, CSS examples) in pasted blocks.

## Root cause

Both ref-grammar surfaces pair a code-fence opener with the NEXT \`\`\` occurrence anywhere in the text:
- server/src/pkm/refs.py `_CODE_FENCE = ```.*?``` (DOTALL, lazy)`
- web/src/grammar/scan.ts `scanCode()` uses `indexOf("```", i + 3)`

When a fenced block contains fenced examples (outer ```markdown holding inner ```html / ```css / ```mermaid snippets), the opener pairs with the inner fence's OPENING marker (its info string is ignored), fence parity flips, and the inner code body is left unstripped. Hex colours like `#ffcdd2` then match the hashtag rule and mint pages. CommonMark never mis-pairs this way: a closing fence cannot carry an info string.

Live repro in prod: block uKBRcctCH (46KB pasted chat instructions) — outer ```markdown fence, inner ```css example at lines 183-184 exposed; still holds live tag refs to 'ffcdd2' and 'fff9c4'. 27 empty hex-titled pages exist in prod (created Oct 8 2025 – Dec 29 2025).

## Fix

A ``` run only closes a fence when followed by whitespace or end-of-text (an info-string character means it is an opener/text, not a closer). Apply identically in refs.py and scan.ts; rewrite the Python side as a linear scan (the lazy regex is also O(n^2)-prone on backtick runs).

- [x] Add failing cases to shared/fixtures/ref_grammar.json (nested fences with info strings; hex colours must not become tags)
- [x] Fix server/src/pkm/refs.py _strip_code
- [x] Fix web/src/grammar/scan.ts scanCode
- [x] Regenerate shared/fixtures/refs_parity.json via pkm.refs_parity_dump
- [x] Server: uv run pytest -q (1446 passed, 96.96% cov), pyrefly clean, ruff clean
- [x] Web: pnpm verify (2078 unit + 53 e2e, exit 0)
- [x] Produce delete-list of minted hex pages (empty, code-only refs) for Arthur to confirm

## Verification against prod data

Ran old vs new extractor over all 464 fenced blocks in a prod DB copy: exactly one block (uKBRcctCH) changes, losing exactly the two spurious tags (ffcdd2, fff9c4). No refs gained, no legitimate refs lost. The fixed extractor over the full 46KB block yields zero refs (whole outer fence opaque, matching how it should render).

27 empty hex-titled pages listed for deletion (all 0 blocks, 0 sidebar; only ffcdd2/fff9c4 hold 1 stale ref each, cascade-deleted with the page).

## Summary of Changes

- server/src/pkm/refs.py: _CODE_FENCE closer now requires no following word character (`(?!\w)`) — an inner fence's opener (```css, ```mermaid) can no longer close an outer fence.
- web/src/grammar/scan.ts: scanCode skips closer candidates followed by [\p{L}\p{N}_], mirroring refs.py.
- 3 new cases in shared/fixtures/ref_grammar.json; 2 new samples in refs_parity_dump.py; refs_parity.json regenerated; span test in scan.test.ts.
- Merged --no-ff at edaca32, pushed, deployed to prod, bundle-verified (Ab.test(t[u+3]) closer-skip in served index-C5yGdO6F.js; healthz ok).
- Deletion of the 27 minted pages awaits Arthur's confirmation (list in bean body / session output).
