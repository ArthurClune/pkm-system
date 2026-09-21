---
# pkm-7cfq
title: 'Fix up Local copy:: values to full on-disk filenames'
status: completed
type: task
priority: normal
created_at: 2026-09-21T11:02:53Z
updated_at: 2026-09-21T11:09:01Z
---

One-off data fix: normalise 'Local Copy::'/'Local copy::' blocks to 'Local copy:: iCloud/Documents/<folder>/<file>.pdf' by fuzzy-matching page/parent titles against the readdle iCloud Documents tree; ambiguous cases resolved by subagents reading the PDFs. Fix-up only; the clickable-link/import design is a separate decision.


## Checklist
- [x] Audit all 603 Local copy:: blocks (scratchpad audit.py / resolve.py)
- [x] Apply 212 strong fuzzy matches via pkm batch (auto.json)
- [x] Subagents resolve 102 ambiguous items by reading PDFs (slice0-3 -> verdict0-3): 95 found, 2 unsure, 5 missing
- [x] Apply 95 confirmed verdicts; normalise remaining 46 'Local Copy::' spellings and 3 malformed values
- [x] Report unresolved to Arthur

## Summary of Changes
Data-only fix via pkm batch (no code). 603 blocks audited: 244 already full paths; 212 fixed by fuzzy title match (page title, or parent block title for nested blocks); 95 fixed by sonnet subagents reading PDFs/URLs; 46 spelling-normalised. Final state: 552 blocks read 'Local copy:: iCloud/Documents/<folder>/<file>'; 36 empty; 7 Goodlinks/Instapaper; 8 folder-only where the paper is not on disk or ambiguous. Scripts lived in the session scratchpad (audit/resolve/apply); nothing committed. Follow-up design question open: serve via /api/local route vs import PDFs as content-addressed assets.
