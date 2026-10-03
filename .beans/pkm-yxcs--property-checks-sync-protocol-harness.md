---
# pkm-yxcs
title: 'Property checks: sync protocol harness'
status: in-progress
type: feature
priority: normal
created_at: 2026-10-02T10:57:25Z
updated_at: 2026-10-03T09:17:05Z
parent: pkm-nws9
---

fast-check model-based test driving the real web sync stack (op queue, replica, recovery) against a real server with fault injection: offline edits, lost acks, duplicate delivery, reloads, multiple clients. Converge with nothing lost or applied twice. Needs its own brainstorm/spec.
