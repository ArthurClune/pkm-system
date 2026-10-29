---
# pkm-6rto
title: GoodLinks reader's original link renders any URL scheme
status: in-progress
type: bug
priority: low
created_at: 2026-10-27T10:53:09Z
updated_at: 2026-10-29T16:06:50Z
parent: pkm-mfd0
---

From the SECURITY.md review (2026-10-27, finding M8). GoodlinksReader.tsx renders <a href={article.url}> ("original") straight from GoodLinks' answer with no scheme check; React 18 renders javascript: hrefs. Markdown links go through isSafeHref; this one does not. Low likelihood (GoodLinks would have to hold such a URL), trivial fix.

- [ ] Red unit test: a javascript: article.url renders no live href
- [ ] Route the href through isSafeHref (or render the URL as text when unsafe)
- [ ] SECURITY.md: widen 'rendered links reject javascript:' back to every link
- [ ] troubleshooting.md row
