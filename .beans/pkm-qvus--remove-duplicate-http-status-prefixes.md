---
# pkm-qvus
title: Remove duplicate HTTP status prefixes
status: todo
type: bug
priority: low
created_at: 2026-08-01T19:23:16Z
updated_at: 2026-08-01T19:23:16Z
parent: pkm-ulae
---

## Context

pkm-ulae finding 29: friendly_error and ApiError both prefix HTTP statuses, producing CLI/MCP text such as 404: 404: page not found.

## Checklist

- [ ] Add exact core, client, CLI, and MCP error-string tests
- [ ] Assign numeric status formatting to ApiError alone
- [ ] Preserve 401 and operation-detail wording
- [ ] Run focused tests, pyrefly, and ruff
- [ ] Commit implementation and bean summary
