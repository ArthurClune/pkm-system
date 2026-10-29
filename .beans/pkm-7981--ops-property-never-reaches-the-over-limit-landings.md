---
# pkm-7981
title: Ops property never reaches the over-limit landing's unlink rule
status: in-progress
type: task
priority: normal
created_at: 2026-10-25T15:21:22Z
updated_at: 2026-10-29T11:30:42Z
parent: pkm-mfd0
---

From the security/batch-server Task 8 review (2026-10-25, finding M5 in that branch's task-7-8 review). The ops property drew R1's model rule (an over-limit replay lands with gone titles unlinked) 0 of 380 times, and structurally cannot: EMOJI_AT_CAP is the only stored text near the cap; a block holding ((P)) beside a title link inlines past the cap so that delete is refused as limit; the only over-cap replay left is a block that is exactly ((P)), which has no title to unlink; the machine has no rename rule, so retitles never occur. The old plain 'over the length cap' path also read 0%.

- [ ] A within-limit long text in LIMIT_TEXTS (e.g. 600,000 ASCII chars) so [[Alpha]] ((P)) survives the delete
- [ ] An extended edit variant that appends one of before's ((uid)) tokens, doubling a copy past the cap
- [ ] Read the reach rate of the landing event in a merge-profile run
- [ ] Mutant (land op.text as sent) fails model_agrees/pages
- [ ] Retitles: a rename rule in the machine, or a recorded decision that unit tests cover it (then mirror retitles in the model's landing rule)
