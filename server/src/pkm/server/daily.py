# pattern: Functional Core
"""The server-side pieces of the daily/journal machinery: the date
window, the emptiness test for the empty-daily cleanup, and which days a
journal batch shows. The date <-> title spelling itself lives in
`pkm.contracts.daily`, shared with the CLI and MCP server."""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import date, timedelta


def past_week_dates(today: date) -> list[date]:
    """The 7 dates before `today`, newest first. `today` itself is excluded:
    the journal auto-creates today's page for composing."""
    return [today - timedelta(days=i) for i in range(1, 8)]


def is_page_empty(texts: Sequence[str]) -> bool:
    """True when every block text is empty/whitespace (or there are none)."""
    return all(not t.strip() for t in texts)


def select_journal_days(nonempty: Iterable[date], today: date,
                        before: date | None, limit: int) -> list[date]:
    """The dates a journal batch shows, newest first (pkm-03x6). With no
    cursor: today leads — always, even when empty, so there is a page to
    compose into — followed by the most recent non-empty days before it.
    With a `before` cursor: the most recent non-empty days strictly before
    it. Empty gap days are omitted entirely; a batch shorter than `limit`
    tells the client the journal is exhausted."""
    if before is None:
        pool = sorted((d for d in nonempty if d < today), reverse=True)
        return [today, *pool[:max(0, limit - 1)]]
    pool = sorted((d for d in nonempty if d < before), reverse=True)
    return pool[:limit]
