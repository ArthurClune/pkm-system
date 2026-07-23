---
# pkm-ij88
title: search input and create new page
status: completed
type: bug
priority: normal
created_at: 2026-07-23T19:55:57Z
updated_at: 2026-07-23T21:15:00Z
---

In the search results dropdown, if there is no page matching the entered text, "Create new page" should be the top item in the dropdown not the last

## Summary of Changes

Fixed the ordering of search results when no exact page match exists:
- Modified SearchBar.tsx to prepend the "Create new page" row to the displayRows array instead of appending it
- Updated SearchBar.test.tsx to reflect the new order: the test "Shift+Enter on the create-page row still creates and navigates" now tests with the create row at the initial selection (index 0) instead of requiring arrow key navigation

The fix ensures that when searching and no exact page match is found, users see the "Create new page" option immediately at the top of the dropdown, making it the most discoverable action.

All unit tests pass (1412 tests), typecheck is clean, and E2E tests pass (27 tests).
