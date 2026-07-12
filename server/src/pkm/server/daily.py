# pattern: Functional Core
"""Roam's ordinal daily-page titles (date <-> 'July 8th, 2026') and the
pure pieces of the empty-daily cleanup: date window + emptiness test."""
from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import date, timedelta

_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]
_TITLE_RE = re.compile(
    rf"^({'|'.join(_MONTHS)}) (\d{{1,2}})(st|nd|rd|th), (\d{{4}})$")


def _suffix(day: int) -> str:
    if 10 <= day % 100 <= 20:
        return "th"
    return {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")


def title_for_date(d: date) -> str:
    return f"{_MONTHS[d.month - 1]} {d.day}{_suffix(d.day)}, {d.year}"


def date_for_title(title: str) -> date | None:
    m = _TITLE_RE.match(title)
    if not m:
        return None
    month = _MONTHS.index(m.group(1)) + 1
    try:
        d = date(int(m.group(4)), month, int(m.group(2)))
    except ValueError:
        return None
    return d if title_for_date(d) == title else None


def past_week_dates(today: date) -> list[date]:
    """The 7 dates before `today`, newest first. `today` itself is excluded:
    the journal auto-creates today's page for composing."""
    return [today - timedelta(days=i) for i in range(1, 8)]


def is_page_empty(texts: Sequence[str]) -> bool:
    """True when every block text is empty/whitespace (or there are none)."""
    return all(not t.strip() for t in texts)
