---
# pkm-j7ez
title: toc e2e flake after slash-dates under load
status: todo
type: bug
created_at: 2026-09-24T09:42:30Z
updated_at: 2026-09-24T09:42:30Z
---

web/e2e/toc.spec.ts fails when it runs right after slash-dates.spec.ts under load: the /h1 block's "Intro" text and heading never reach the block tree, so the toc renders "no headings". Passes alone.

Reproduced 2 of 5 on an exported copy of main before GoodLinks, 6 of 9 on the GoodLinks feature tree. Looks like a race in the /toc feature (pkm-mzks) or its spec. Found 2026-09-23.
