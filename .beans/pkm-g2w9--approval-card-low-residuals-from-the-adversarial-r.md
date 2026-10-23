---
# pkm-g2w9
title: 'Approval card: low residuals from the adversarial re-review'
status: todo
type: task
priority: low
created_at: 2026-10-23T22:09:59Z
updated_at: 2026-10-23T22:09:59Z
parent: pkm-mfd0
---

Adversarial re-review of security/approval-card at 2cd286c4 (2026-10-23) found the target property SAFE, with low residuals (details and one-line fixes in that branch's review; summarised here):

- [ ] Bound refusal messages: a 2 MB unknown key yields a 2 MB refusal to server.log and to the model on every retry (escaped, so no forgery). Truncate the key in the message.
- [ ] Bound total preview size / op count (200 ops x 50,000 chars = 10 MB card; DoS only).
- [ ] A repeated batch `as` alias resolves to the later block; the warning says "earlier in this batch" without naming which. Name it, or refuse duplicate aliases.
- [ ] A target value starting with an RTL letter renders RTL while the same title in the warning renders LTR ("ד 2" vs "2 ד"): put dir="ltr" on values.
- [ ] Defence in depth: the web card renders any key the server sends; consider rejecting keys not in a per-action allow-list client-side.
- [ ] Possible feature: show a uid target's current block text on the card, so a model that lies about which block a uid is gets caught (outside the stated property).
