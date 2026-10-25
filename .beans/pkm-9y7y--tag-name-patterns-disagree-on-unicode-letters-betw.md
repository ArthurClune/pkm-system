---
# pkm-9y7y
title: Tag-name patterns disagree on Unicode letters between server and web
status: in-progress
type: bug
priority: low
created_at: 2026-10-25T02:14:32Z
updated_at: 2026-10-25T09:38:33Z
parent: pkm-mfd0
---

From the pkm-gc3n/bppf Task 1 fix round (2026-10-24). scan.ts TAG_CHARS_RE and refs.py _TAG_NAME test letters with each runtime's Unicode tables: '#' followed by U+A7CB (Unicode 16) is a tag on the web but not on the server. Ref extraction differs (not nesting depth). Making the class ASCII would break #café, so pin both to one explicit table or one Unicode version.

- [x] Parity fixture case for a Unicode-16 letter in a tag
- [x] One explicit letter class shared by both sides (generated)
- [ ] troubleshooting.md row
