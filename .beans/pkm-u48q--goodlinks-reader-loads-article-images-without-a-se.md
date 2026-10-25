---
# pkm-u48q
title: GoodLinks reader loads article images from the GoodLinks copy, not the source
status: todo
type: task
priority: normal
created_at: 2026-10-23T15:00:12Z
updated_at: 2026-10-25T05:05:28Z
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

## Research (2026-10-25) — blocked on Arthur's choice

GoodLinks' local API has no image endpoint; article HTML/markdown carry only the original https URLs (15 sampled articles, 0–283 remote <img> each). GoodLinks does download images into per-link folders in its sandbox (library DB at ~/Library/Group Containers/group.com.ngocluu.goodlinks/Data/data.sqlite), but reading those folders hangs on macOS's 'access data from other apps' consent check — the prod server would hit the same block. Full evidence: docs/superpowers/handoffs/2026-10-25-u48q-goodlinks-images-research.md (gitignored, main checkout).

Options for Arthur: A) grant the server's launcher access to GoodLinks' data and map its undocumented layout (fragile across GoodLinks updates; needs read timeouts); B) PKM fetches and keeps its own copy of each article's images once (the Mac contacts source sites, not GoodLinks' copy); C) no images — drop <img>, keep alt text; D) ask GoodLinks' developer for an image endpoint, C or today's behaviour meanwhile. Any option: give the reader iframe a CSP allowing images only from the app (or none for C).

Side findings: files-and-assets.md says GoodLinks 'archives text but not images' (wrong with image download on); GoodLinks listens on *:9428, not loopback only; GoodlinksGateway.content never disables GoodLinks' download-if-uncached, so opening the reader on an uncached link may make GoodLinks fetch the page.
