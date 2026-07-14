---
# pkm-h49t
title: Current Work page
status: completed
type: feature
priority: normal
created_at: 2026-07-14T19:39:37Z
updated_at: 2026-07-14T20:25:00Z
---


Create a new page called "Current Work". It should be linked under "Daily Notes" in the left sidebar and show sections for pages changed in last 24hrs. 48hrs and 7 days


## Implementation Checklist

- [x] Confirm design for Current Work page
- [x] Add tests for navigation and changed-page grouping
- [x] Implement route, view, data query, and sidebar link
- [x] Verify web checks
- [x] Summarize changes and complete bean


## Summary of Changes

Implemented `/api/current-work` with exclusive changed-page buckets, matching offline replica support, a `/current-work` React page, and a left-nav link under Daily Notes. Added server, local API, view, and app route tests. Regenerated OpenAPI and TypeScript API types.

Verification:
- `cd server && uv run pytest -q`
- `cd server && uv run pyrefly check && uv run ruff check`
- `cd web && pnpm verify`
