---
# pkm-3k4m
title: Escape request-controlled text in pkm.* log lines
status: completed
type: bug
priority: low
created_at: 2026-10-23T12:28:27Z
updated_at: 2026-10-23T18:40:00Z
parent: pkm-mfd0
---

Follow-up from pkm-6fqw's review: the access log now escapes non-printables and quotes (logfmt.escape_controls), but other pkm.* loggers still write request-derived text unescaped to server.log, all behind auth:
- local_open.probe logs key (the requested local path) in four warnings
- routes_local._request_download logs path
- export/writer asset-repair warning logs fname (stored upload filename)
- describe/service logs error text from the describe call

- [x] Red test: a control character / U+2028 in one of these values reaches server.log raw
- [x] Escape at those call sites with logfmt.escape_controls, or a logging Filter on the pkm handler (decide which; a Filter covers future loggers)
- [x] troubleshooting.md row

## Summary of Changes

A handler-level filter, `logfmt.EscapePkmMessages`, on the `default` handler
in both the stderr and the `--log-dir` file config. For each `pkm`/`pkm.*`
record it returns a copy whose message is `escape_controls(getMessage())`
with `args` emptied, so %-style and pre-formatted messages are covered and
the original record is untouched; `exc_info` is left for the formatter, so
tracebacks stay multi-line. uvicorn records pass unchanged (its formatter
re-renders `color_message` with the record's args, and it ends a message
with the newline before a traceback on purpose). `pkm.access` uses its own
handler, already escaped by `request_line`, so nothing is escaped twice. No
call site escaped before, so none changed. Tests drive `_request_download`
and `OpenProber.probe` through the real file config; detaching the filter
fails both. backend.md logging section and a troubleshooting row updated.

Review follow-up: `logfmt.EscapingFormatter` (uvicorn's DefaultFormatter
subclass, both config variants) passes every traceback and stack, from any
logger, through `indent_traceback`: non-printables but the newline
hex-escaped, every line indented two spaces, so an exception's text cannot
start a column-0 line. The filter returns the record unchanged when
`getMessage()` raises, so a malformed call is reported by `handleError`
instead of raising into the caller. Docstring and backend.md now state that
uvicorn records can carry a websocket path (line-safe, quotes raw), and the
diagnostics route comment says how to decode its now-escaped dump.
