---
# pkm-f3mo
title: Make assistant SSE teardown deterministic and name lifecycle protocols
status: todo
type: bug
priority: high
tags:
    - review
    - backend
created_at: 2026-08-17T20:55:22Z
updated_at: 2026-08-17T20:55:22Z
parent: pkm-wvvu
---

## Review findings

Backend correctness-adjacent SSE teardown plus the `ClaudeConversation.send`, `create_conversation`, duplicated decline loop, and comment-density findings.

Disconnecting `_with_keepalive` cancels a pending `anext` but does not explicitly close the underlying async generator, leaving critical decline/interrupt cleanup to async-generator finalization.

## Acceptance criteria

- [ ] Explicitly `aclose()` the underlying stream during keepalive/SSE teardown without masking the original disconnect
- [ ] Add a disconnect regression test proving parked confirmations are declined, the bounded interrupt runs, and the conversation becomes unhealthy deterministically
- [ ] Extract and reuse a named abandon-turn protocol for decline, interrupt, and health state
- [ ] Extract pure model/environment resolution from conversation creation
- [ ] Consolidate identical decline-all-pending loops
- [ ] Keep one canonical explanation of the assistant admission-lock timeout story and cross-reference it elsewhere
- [ ] Preserve timeout bounds, cancellation safety, and provider routing with focused tests and architecture updates
