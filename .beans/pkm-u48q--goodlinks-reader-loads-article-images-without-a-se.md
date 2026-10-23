---
# pkm-u48q
title: GoodLinks reader loads article images from the GoodLinks copy, not the source
status: todo
type: task
priority: normal
created_at: 2026-10-23T15:00:12Z
updated_at: 2026-10-23T15:13:08Z
parent: pkm-mfd0
---

Adversarial review of pkm-tk9i (M3). Opening the GoodLinks reader
(`GoodlinksReader.tsx`, sandboxed srcdoc iframe) loads the article's images
from their source sites: `GET /api/goodlinks/{link_id}` returns GoodLinks'
article HTML through `sanitize_article` (`server/src/pkm/goodlinks.py`), which
keeps each `<img src>` as the original http(s) URL.

Arthur (2026-10-23): the reader should load article images on open, but from
the GoodLinks copy, not the source site.

- [ ] Find out how to reach an article's downloaded images: an endpoint of
  GoodLinks' local API (`goodlinks_api_url`, `goodlinks_gateway.py`), or
  files in its container. They exist: Arthur's GoodLinks is set to download
  article images (2026-10-23)
- [ ] Serve them through the app (for example a `/api/goodlinks/{link_id}/…`
  image route through the gateway), and have `sanitize_article` rewrite
  `<img src>` to it; drop any image with no local copy rather than fall back
  to the source URL
- [ ] Test: the reader's HTML carries no external `src`; an e2e with request
  interception sees no request leave the app's origin on open
- [ ] API reference row in `backend.md`; `files-and-assets.md` § GoodLinks copies
