---
# pkm-wvac
title: 'Property checks: draw page deletes in the sync suite'
status: todo
type: task
created_at: 2026-10-13T21:10:21Z
updated_at: 2026-10-13T21:10:21Z
---

Follow-up to pkm-wlkh. Page delete now rewrites inbound blocks and records `unlink`/`inline` replay rows so stale offline edits do not resurrect the page. The pure rewriter has Hypothesis properties (server/tests/props/test_unlink_props.py, incl. replay reproducing the rewrite), but no multi-device suite ever draws a page delete: the web sync oracle only replays renames (`/__proptest/renames`).

Add a delete command to the web sync property suite (and the harness server's control routes / oracle) so a delete racing offline edits on 2-3 clients is checked end to end.

## Todo
- [ ] Harness: log page deletes like renames (route or trigger) for the oracle
- [ ] Draw delete commands in web/src/props/sync
- [ ] Oracle: replay unlink/inline over serial edits
