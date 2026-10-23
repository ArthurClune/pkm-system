---
# pkm-3k4m
title: Escape request-controlled text in pkm.* log lines
status: todo
type: bug
priority: low
created_at: 2026-10-23T12:28:27Z
updated_at: 2026-10-23T12:28:27Z
parent: pkm-mfd0
---

Follow-up from pkm-6fqw's review: the access log now escapes non-printables and quotes (logfmt.escape_controls), but other pkm.* loggers still write request-derived text unescaped to server.log, all behind auth:
- local_open.probe logs key (the requested local path) in four warnings
- routes_local._request_download logs path
- export/writer asset-repair warning logs fname (stored upload filename)
- describe/service logs error text from the describe call

- [ ] Red test: a control character / U+2028 in one of these values reaches server.log raw
- [ ] Escape at those call sites with logfmt.escape_controls, or a logging Filter on the pkm handler (decide which; a Filter covers future loggers)
- [ ] troubleshooting.md row
