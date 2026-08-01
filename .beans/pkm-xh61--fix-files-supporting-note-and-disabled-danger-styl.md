---
# pkm-xh61
title: Fix Files supporting-note and disabled-danger styling
status: completed
type: bug
priority: low
created_at: 2026-08-01T19:19:43Z
updated_at: 2026-08-01T19:30:32Z
parent: pkm-6phf
---

Fix pkm-6phf findings 16 and 17 together because they share stylesheet and Files test surfaces.

## Checklist

- [ ] Add failing selector and disabled-state coverage
- [ ] Make settings-note styling reusable in Files
- [ ] Make disabled danger-button feedback consistent
- [ ] Update frontend architecture documentation
- [x] Run focused web checks

## Summary of Changes

Promoted Files supporting-note styling to shared `p.settings-note`, guarded danger hover and aligned disabled danger feedback, added stylesheet and Files contract coverage, updated frontend architecture documentation, and passed the focused Vitest, typecheck, lint, and FCIS gates. Full `pnpm verify` was intentionally deferred to the integration branch per lane instructions.
