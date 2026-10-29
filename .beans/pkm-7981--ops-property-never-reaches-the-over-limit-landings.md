---
# pkm-7981
title: Ops property never reaches the over-limit landing's unlink rule
status: completed
type: task
priority: normal
created_at: 2026-10-25T15:21:22Z
updated_at: 2026-10-29T11:30:42Z
parent: pkm-mfd0
---

From the security/batch-server Task 8 review (2026-10-25, finding M5 in that branch's task-7-8 review). The ops property drew R1's model rule (an over-limit replay lands with gone titles unlinked) 0 of 380 times, and structurally cannot: EMOJI_AT_CAP is the only stored text near the cap; a block holding ((P)) beside a title link inlines past the cap so that delete is refused as limit; the only over-cap replay left is a block that is exactly ((P)), which has no title to unlink; the machine has no rename rule, so retitles never occur. The old plain 'over the length cap' path also read 0%.

- [x] A within-limit long text in LIMIT_TEXTS (e.g. 600,000 ASCII chars) so [[Alpha]] ((P)) survives the delete -- LONG_WITHIN_CAP (10,001 'x') in limit_texts.py, outside LIMIT_TEXTS, so the title link survives the delete; test_limit_texts_are_what_they_claim pins its size
- [x] An extended edit variant that appends one of before's ((uid)) tokens, doubling a copy past the cap -- replaced by the plan's scripted offline 'over the cap' kind in test_ops_state.py (copies of one block's ((uid)) past the cap); the bean's random-generator items reached the landing 0 times in 380 examples
- [x] Read the reach rate of the landing event in a merge-profile run -- landing event 'update_text replay: over the length cap, gone titles unlinked' reached 16.43% and 14.32% of examples in the final merge-profile runs (0% in baseline)
- [x] Mutant (land op.text as sent) fails model_agrees/pages -- mutant 'land op.text as sent' fails deletes_agree on the pages assert; a second mutant (replay walk stops at the step over the cap) fails the same way
- [x] Retitles: a rename rule in the machine, or a recorded decision that unit tests cover it (then mirror retitles in the model's landing rule) -- retitles are pinned by the two rename unit tests in test_text_limits_ops.py (test_an_over_limit_replay_after_a_rename_does_not_recreate_the_old_title and test_an_over_limit_replay_unlinks_a_padded_renamed_away_title); no rename rule in the machine

## Summary of Changes

- `server/tests/props/limit_texts.py`: `COPIES_PAST_CAP = 100` and `LONG_WITHIN_CAP = "x" * (TEXT_CAP // COPIES_PAST_CAP + 1)` (10,001 characters), outside `LIMIT_TEXTS` so a title link survives the delete; 100 copies are 1,000,100 characters, past the cap.
- `server/tests/props/test_ops_state.py`: a scripted offline kind `over the cap` (`_over_the_cap`) copies one block's `((uid))` past the cap, deletes the titles, then sends the hashed edit; `delete_page` returns its status code. Events cover refused, one step and two steps.
- `server/tests/props/model.py` and `test_model.py`: the rename comment names the two rename unit tests; `test_limit_texts_are_what_they_claim` pins the sizes and `test_an_over_cap_replay_unlinks_the_titles_of_steps_past_it` pins the model rule.
- `docs/architecture/checks.md` Property gate: the `test_ops_state.py` row now holds an over-limit replay's landing with its deleted titles plain. AGENTS.md's server property budget now says about 4 and a half minutes (`proptest/check.sh` server passed at 263 s).
- Reach: the landing event `update_text replay: over the length cap, gone titles unlinked` reached 16.43% and 14.32% of examples in the final merge runs (0% in baselines); `delete page blocker: limit` fell to about 0.25% from 1.7 to 4.6%.
- Wall time: merge runs 152 and 175 s against 119 to 137 s baselines (the first constant, 10 copies, ran 192 to 295 s).
- Mutants (both fail `deletes_agree` on `pages == model.pages`, not on an exception): `landed = op.text` (272 s, `{'Alpha', 'Beta'} != {'Alpha'}`); replay walk stops at the step over the cap (346 s, `{'Alpha', 'Gamma'} != {'Alpha'}`).

Rulings:
- No rename rule in the ops machine; retitles are pinned by the two rename tests in `test_text_limits_ops.py` (plan "For Arthur" 1).
- A scripted offline kind replaces the bean's random-generator items, which reached the landing 0 of 380 times (plan "For Arthur" 2).
- Gate cost promoted to a fix round: `COPIES_PAST_CAP` 10 to 100 keeps the reach and cuts per-copy work tenfold (about +100 s per server proptest run down to about +35 s); revert to 10 if wrong.
- Parked: `text: at the nesting limit` dipped under half the baselines, judged noise; a replay run where a clean model label dropped is a label shift, with no server branch lost.
