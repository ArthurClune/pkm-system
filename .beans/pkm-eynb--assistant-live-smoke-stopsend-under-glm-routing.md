---
# pkm-eynb
title: 'Assistant: live-smoke Stop→send under GLM routing'
status: todo
type: task
created_at: 2026-11-07T22:00:16Z
updated_at: 2026-11-07T22:00:16Z
---

Follow-up to pkm-74vc (assistant turn phase: drain the aborted result after Stop or a stall). Its Stop→send live smoke ran under Claude routing only; the GLM run was skipped because Arthur declined key access on 2026-11-07.

## What to run

The same smoke as for Claude, against a scratch server on port 8975 with a temporary data dir (never production on 8974):

1. Start the scratch server as `.claude/skills/verify` describes, with a z.ai key in its environment as `ZAI_API_KEY` so `available_models()` offers `glm`.
2. Log in, `POST /api/assistant/conversations` with `{"model": "glm"}`.
3. Stream a long first message (e.g. "write the numbers 1 to 300 with their English names") and close the stream after a few `text_delta` events: that is Stop.
4. After a short pause, send "Reply with exactly the single word PINEAPPLE", then "... MANGO".
5. Pass: the second turn ends on `turn_done` with PINEAPPLE and the third with MANGO. Fail (the pkm-74vc bug): the second turn ends at once on `assistant error: error_during_execution` and every later reply answers the previous message.
6. Stop the server by PID and remove the data dir.

## Proving GLM routing

GLM calls itself Claude, so the reply proves nothing. Show either:

- `ANTHROPIC_BASE_URL` in the CLI subprocess's environment (`ps eww -p <pid>` on the server's `claude` child) equal to `harness_env.ZAI_BASE_URL`; print only that variable, never the token; or
- `assistant harness started (model=glm)` in the scratch server's log.

## Needs

A z.ai key that Arthur supplies for the run. Do not look for one yourself.

- [ ] Stop→send smoke under GLM routing passes, with the routing proof
