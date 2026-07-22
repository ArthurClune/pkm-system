---
# pkm-03x6
title: 'Journal default window: last 5 non-empty days, not 5 calendar days'
status: in-progress
type: feature
priority: normal
created_at: 2026-07-22T14:46:01Z
updated_at: 2026-07-22T15:00:17Z
---

The daily-notes head batch returns the last 5 calendar days; with the Todos tree hopping to today each morning, days 2-5 are empty so only today renders. Change /api/journal (server + offline replica shim) so days=N&before=D returns the N most recent NON-EMPTY daily pages strictly before D (newest first); with no cursor, today is always included first (auto-created) even if empty, for composing. Empty gap days are omitted from the payload. Client stops paging when a response returns fewer days than requested (exhausted) instead of the 3-empty-batches heuristic.

## Design

- New semantics for GET /api/journal?days=N&before=D (server routes_pages.get_journal AND offline shim web/src/replica/localApi/journal.ts, byte-parity):
  - A page is non-empty when any block text has non-whitespace: SQL EXISTS over blocks with trim(text, tab/lf/cr/space) <> '' in both engines.
  - No cursor (head): today first, always (auto-created for composing, even if empty), then the (N-1) most recent non-empty daily pages strictly before today.
  - With before=D: the N most recent non-empty daily pages strictly before D, newest first.
  - Empty gap days are omitted entirely; every returned day has exists=true. Payload shape unchanged.
- Pure selection helper in server daily.py: select_journal_days(nonempty_dates, today, before, limit) (Functional Core); SQL + assembly stays in the route shell. TS mirror in the shim.
- Client (Journal.tsx): cursor stays oldest-loaded date; stop condition = response had fewer days than requested (exhausted -> hide sentinel AND button); errors keep the retry button. Remove MAX_EMPTY_BATCHES/emptyStreak.
- Regenerate shared/fixtures/shim_parity.json (journal_pinned case changes) and server openapi.json + web types (docstring change).

## Checklist

- [x] Server: failing tests for new semantics (gap skipping, head today-first, cursor, exhaustion, clamp)
- [x] Server: pure select_journal_days + route rewrite; tests green
- [x] Regenerate shim_parity.json, openapi.json, web api types
- [x] Shim: journal.ts mirror + router/parity tests green
- [x] Client: Journal.tsx exhaustion stop + tests
- [x] Full verify: server pytest/pyrefly/ruff, web pnpm verify
