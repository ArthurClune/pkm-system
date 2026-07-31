---
# pkm-w80k
title: Keep CLI/MCP batch page creation inside the advertised atomic transaction
status: todo
type: bug
priority: high
created_at: 2026-07-31T15:54:48Z
updated_at: 2026-07-31T15:54:48Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 5.

**References:** server/src/pkm/cli/main.py:360-367,420-433; server/src/pkm/mcp/server.py:38-46,134-150; server/src/pkm/server/ops_core.py:75-95

Both shells call _ensure_page() before fully validating and posting a batch. A batch with a missing page followed by an invalid command can fail while leaving the page committed, contradicting the CLI/MCP "one atomic transaction" contract.

**Direction:** Validate the complete command batch before I/O. Represent missing pages as empty planning payloads and include supported create_page operations in the same OpBatch.

- [ ] Add failed-batch tests asserting no pages or blocks remain
- [ ] Move page creation into the atomic operation batch
