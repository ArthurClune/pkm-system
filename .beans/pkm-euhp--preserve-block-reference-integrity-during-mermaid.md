---
# pkm-euhp
title: Preserve block-reference integrity during Mermaid conversion
status: todo
type: bug
priority: high
created_at: 2026-07-31T15:55:02Z
updated_at: 2026-07-31T15:55:02Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 9.

**References:** server/src/pkm/importer/rows.py:48-61; server/src/pkm/importer/migrate_mermaid_blocks.py:82-93; docs/architecture/backend.md:325-328

Mermaid conversion flattens descendant text and drops/deletes descendant rows and stable UIDs. Any external ((child-uid)) reference becomes permanently unresolved, contradicting the documented UID-preservation invariant.

**Direction:** Detect inbound references before conversion. Preserve referenced descendants, rewrite references only where semantics are valid, or refuse/report conversion. If a lossy mode remains, enumerate every affected UID.

- [ ] Test referenced nested Mermaid descendants
- [ ] Add dry-run reporting of affected UIDs and inbound references
- [ ] Preserve or explicitly gate lossy metadata/UID removal
