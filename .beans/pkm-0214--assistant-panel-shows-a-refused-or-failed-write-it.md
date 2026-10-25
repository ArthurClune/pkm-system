---
# pkm-0214
title: Assistant panel shows a refused or failed write itself
status: todo
type: feature
priority: low
created_at: 2026-10-25T17:04:04Z
updated_at: 2026-10-25T17:22:55Z
parent: pkm-mfd0
---

From the pkm-6fcv plan (2026-10-25). When an allowed write is refused (412: the block changed since the card showed it) or any tool call errors, the user learns of it only through the model's reply; a prompt-injected model could claim the write succeeded. Question for Arthur: should the panel itself show the refusal/error under the tool call?

- [x] Arthur: show tool errors in the panel, or leave it to the model's reply — Arthur 2026-10-25: yes, the panel shows the refusal
- [ ] The panel shows a refused allowed write (412) and other write-tool errors under the tool call, independent of the model's reply
- [ ] troubleshooting/assistant.md updated
