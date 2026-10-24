---
# pkm-e95y
title: Update SECURITY.md after the review fixes land
status: todo
type: task
priority: normal
created_at: 2026-10-23T10:56:27Z
updated_at: 2026-10-24T18:14:44Z
parent: pkm-mfd0
blocked_by:
    - pkm-tk9i
    - pkm-u1jk
    - pkm-1zdg
    - pkm-i9pg
    - pkm-d8vp
    - pkm-ak4e
    - pkm-0ve4
    - pkm-6fqw
    - pkm-h1em
    - pkm-oirq
    - pkm-t74a
    - pkm-3k4m
    - pkm-0d4e
    - pkm-0ln3
    - pkm-ank8
    - pkm-ec46
    - pkm-gvbd
    - pkm-lbj1
    - pkm-xrvv
    - pkm-bppf
---

SECURITY.md is the high-level model; update it once the fixes we take on have shipped (scrap or finish the blockers first), describing the system as it then is. Facts from the review that it currently gets wrong or omits, whatever the fixes:

- [ ] Last-reviewed date and a link to docs/security-review-2026-10-23.md
- [ ] Cookie site is the whole tailnet (ts.net is a public suffix); what Origin checking now covers
- [ ] Login throttle keying (request.client.host via proxy headers) replaces 'every tailnet client shares the proxy's bucket'
- [ ] Local files: only allowlisted raster images and PDFs inline; HTML/SVG download with nosniff
- [ ] Image descriptions send the complete original image, metadata included
- [ ] upload_asset reach: pkm-d8vp withholds it from the assistant (pkm-mcp keeps it; it runs as the user). The prompt-injection bullet should say the assistant gets only the READ_TOOLS/WRITE_TOOLS subset, with --strict-mcp-config
- [ ] Write gating: what the card guarantees to show
- [ ] On-device replica/outbox/cached uploads outlive session-secret rotation
- [ ] Diagnostics body bound
- [ ] Known limitations / hardening priority 2: the anonymous route-walk test now exists (pkm-t74a)

- [ ] Delete docs/superpowers/handoffs/security-review-2026-10-23-probes once the last fix bean has turned its probe into a red test (pkm-t74a handed this on)
