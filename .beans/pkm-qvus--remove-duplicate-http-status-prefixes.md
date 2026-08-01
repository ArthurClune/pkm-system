---
# pkm-qvus
title: Remove duplicate HTTP status prefixes
status: completed
type: bug
priority: low
created_at: 2026-08-01T19:23:16Z
updated_at: 2026-08-01T19:30:59Z
parent: pkm-ulae
---

## Context

pkm-ulae finding 29: friendly_error and ApiError both prefix HTTP statuses, producing CLI/MCP text such as 404: 404: page not found.

## Checklist

- [x] Add exact core, client, CLI, and MCP error-string tests
- [x] Assign numeric status formatting to ApiError alone
- [x] Preserve 401 and operation-detail wording
- [x] Run focused tests, pyrefly, and ruff
- [x] Commit implementation and bean summary

## Summary of Changes

Made `friendly_error()` shape status-neutral details and retained `ApiError` as the sole numeric status renderer. Added exact core, client, CLI, MCP, 401, operation-detail, and status-zero regression coverage.
