---
# pkm-wvac
title: 'Property checks: draw page deletes in the sync suite'
status: completed
type: task
priority: normal
created_at: 2026-10-13T21:10:21Z
updated_at: 2026-10-14T11:07:46Z
blocked_by:
    - pkm-ynze
---

Follow-up to pkm-wlkh. Page delete now rewrites inbound blocks and records `unlink`/`inline` replay rows so stale offline edits do not resurrect the page. The pure rewriter has Hypothesis properties (server/tests/props/test_unlink_props.py, incl. replay reproducing the rewrite), but no multi-device suite ever draws a page delete: the web sync oracle only replays renames (`/__proptest/renames`).

Add a delete command to the web sync property suite (and the harness server's control routes / oracle) so a delete racing offline edits on 2-3 clients is checked end to end.

## Todo
- [x] Harness: log page deletes like renames (route or trigger) for the oracle
- [x] Draw delete commands in web/src/props/sync
- [x] Oracle: replay unlink/inline over serial edits


Design: docs/superpowers/specs/2026-10-14-page-delete-wins-design.md (§ Property suite). Builds on pkm-ynze: the serial replay must map each body's seen-seq to the replay server's seqs, and a new delete-wins invariant joins the oracle.

## Summary of Changes

- Harness logs page deletes (trigger on page_deletions; shared `ord` with renames; block uids from the journal) at `GET /__proptest/deletes`; stale-teeth switch.
- `DeletePage` command (weight 1; spares the page holding pt_seed_6 for BadBatch).
- Oracle replays deletes in commit order with a seen_seq mapping, and checks the new "delete wins" invariant; teeth prove it fails with staleness disabled.
- property-checks.md and AGENTS.md timings updated (sync ~185 s).
- Follow-up: pkm-ialr.
