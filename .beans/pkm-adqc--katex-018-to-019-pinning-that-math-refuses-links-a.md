---
# pkm-adqc
title: katex 0.18 to 0.19, pinning that math refuses links and images
status: completed
type: task
priority: normal
created_at: 2026-11-17T21:55:43Z
updated_at: 2026-11-17T22:05:20Z
parent: pkm-tcca
---

Part of pkm-tcca. Bump katex (and the single-install override in web/pnpm-workspace.yaml) to 0.19.

- [x] Unit test: a math span never renders an <a> or <img> for \\href, \\url, \\includegraphics
- [x] Bump katex and the override; one katex install in the lockfile
- [x] pnpm verify green

## Summary of Changes

katex ^0.18.10 to ^0.19.1, with the single-install override in
web/pnpm-workspace.yaml moved to match; the lockfile holds one katex.

New MathSpan.trust.test.tsx renders real katex through MathSpan and pins that
\\href, \\url, \\includegraphics and the \\html* commands produce no link, image,
src/href attribute or user-chosen attribute value. It passed on 0.18 before
the bump; with trust:true in MathSpan, seven of its eight cases fail
(katex drops a javascript: URL even when trusted).

0.19's one breaking change is in strict: missing glyph metrics now report
through strict (code symbolNotInFont), so under the default strict:"warn" math
with characters outside katex's fonts logs a console warning in the browser.
Rendering is unchanged. Bundle and precache budgets pass (katex chunk 262 KB).

Verification: 7168 unit tests pass. Playwright 129 passed, 1 failed:
assistant.spec 'in a very short window...', which fails 2 in 8 run alone on
main as well (filed as pkm-icoc).
