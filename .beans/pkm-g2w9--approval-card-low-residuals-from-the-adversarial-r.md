---
# pkm-g2w9
title: 'Approval card: low residuals from the adversarial re-review'
status: completed
type: task
priority: low
created_at: 2026-10-23T22:09:59Z
updated_at: 2026-10-25T02:00:00Z
parent: pkm-mfd0
---

Adversarial re-review of security/approval-card at 2cd286c4 (2026-10-23) found the target property SAFE, with low residuals (details and one-line fixes in that branch's review; summarised here):

- [x] Bound refusal messages: a 2 MB unknown key yields a 2 MB refusal to server.log and to the model on every retry (escaped, so no forgery). Truncate the key in the message.
- [x] Bound total preview size / op count (200 ops x 50,000 chars = 10 MB card; DoS only).
- [x] A repeated batch `as` alias resolves to the later block; the warning says "earlier in this batch" without naming which. Name it, or refuse duplicate aliases.
- [x] A target value starting with an RTL letter renders RTL while the same title in the warning renders LTR ("ד 2" vs "2 ד"): put dir="ltr" on values.
- [x] Defence in depth: the web card renders any key the server sends; consider rejecting keys not in a per-action allow-list client-side.
- [x] Possible feature: show a uid target's current block text on the card, so a model that lies about which block a uid is gets caught (outside the stated property).

## Decision (Arthur, 2026-10-24)

See docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md, row pkm-g2w9.

## Summary of Changes

Plan: docs/superpowers/plans/2026-10-25-approval-card-targets.md.

- Refusals are bounded: every echoed value goes through `pkm.echo.echo`
  (unknown argument, command, param key, alias, over-range int), and
  `build_write_preview` cuts any refusal at `REFUSAL_LIMIT_CHARS`.
- The card is bounded: at most `MAX_OPS_PER_BATCH` commands and
  `PREVIEW_LIMIT_CHARS` across targets, content, warnings and current
  values; past either the call is refused, telling the model to split.
- `pkm.batch.batch_aliases` refuses a reused `as` and an alias used before
  the command that makes it, in `validate_batch` and `plan_batch`.
- Every value `<bdi>` and every warning line on the card has `dir="ltr"`.
- The web allows each action only the keys in the generated
  `previewKeys.gen.ts` (each once, and only the server's excerpt clip);
  anything else leaves Deny only.
- The card shows each updated, moved or deleted block's current page and
  text (a clipped excerpt with its full length), "no block has this uid",
  or the batch write that creates an alias. A delete says how many blocks
  sit under its target in the store as read; a batch whose delete would
  take a block an earlier write of the batch moved under it (directly,
  through an alias, or under a descendant), or where the card cannot tell,
  is refused, so the count leaves out no existing block. The server reads
  them in one snapshot just before the card, and a queued card read before
  an earlier Allow says so.
- Docs: assistant.md (approval card, bounds, the blocks a write changes),
  cli-and-mcp.md, cli.md, backend.md generated artifacts, frontend.md mint
  site, two troubleshooting rows.
- Follow-up filed: pkm-6fcv (Allow should not overwrite a text edited while
  the card is open).
