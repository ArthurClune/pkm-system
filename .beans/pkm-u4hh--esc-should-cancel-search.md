---
# pkm-u4hh
title: Esc should cancel search
status: completed
type: bug
priority: normal
created_at: 2026-07-10T18:55:33Z
updated_at: 2026-07-10T19:19:54Z
---

Pressing Escape while the search UI is open/focused should cancel/close the search. Currently it does not.

## Summary of Changes

Fixed as part of the SearchBar redesign (see pkm-fatg). Root cause: Escape was only handled on the modal's input element, so once focus left the input nothing listened for it. SearchBar now cancels on Escape both at the input and at the document level while the dropdown is open (plus on outside click): the query is cleared, the dropdown closes, in-flight responses are dropped, and the input blurs. Verified end-to-end in the running app.
