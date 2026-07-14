---
# pkm-zws4
title: 'Journal: consider not rendering days whose page doesn''t exist'
status: completed
type: feature
priority: normal
created_at: 2026-07-12T17:37:03Z
updated_at: 2026-07-14T20:10:25Z
---

Follow-up idea from empty-daily-cleanup design (2026-07-12): the Journal currently renders every day in the window identically whether the page row exists or not. Non-existent past days should not be displayed


## Implementation Checklist

- [x] Keep /api/journal payload and pagination semantics unchanged
- [x] Hide non-existent past days at Journal render time
- [x] Keep the first loaded day (today) visible for composing even if exists=false
- [x] Update Journal tests for hidden days and pagination through hidden batches
- [x] Make E2E test port configurable with E2E_PORT so verification can avoid an occupied 8975
- [x] Run web verification on alternate port 8976

## Summary of Changes

Journal now renders only existing days plus the first loaded day, preserving today's composer while hiding non-existent past days. The client still stores every fetched day internally, so before= pagination and empty-batch auto-load stopping continue to use the server-provided date window. Tests cover hidden non-existent days, the today exception, and pagination through hidden empty batches. Playwright E2E configuration now honors E2E_PORT, defaulting to 8975, so verification can run on another port when 8975 is intentionally occupied.
