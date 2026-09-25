# pattern: Functional Core
"""Parse a since/until change window and classify blocks as new or edited
within it, for `GET /api/changed` (pkm-6eea, `pkm changed`). Pure: the
clock ("now") and the local timezone are passed in by the caller, never
read here, so the window math is exercised without mocking the system
clock."""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone, tzinfo

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ChangedWindowError(ValueError):
    """An unparseable since/until bound, or since >= until."""


def local_tz(now: datetime) -> tzinfo:
    """`now`'s own tzinfo, so callers built on `datetime.now().astimezone()`
    (whose `.tzinfo` is typed as optional even though it is never actually
    None) have a plain `tzinfo` to pass around. Falls back to UTC in the
    unreachable case where it is."""
    return now.tzinfo if now.tzinfo is not None else timezone.utc


def _parse_bound(value: str, tz: tzinfo, label: str) -> datetime:
    if _DATE_RE.fullmatch(value):
        try:
            d = date.fromisoformat(value)
        except ValueError:
            raise ChangedWindowError(
                f"{label}: not a valid date: {value!r}") from None
        return datetime(d.year, d.month, d.day, tzinfo=tz)
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        raise ChangedWindowError(
            f"{label}: expected YYYY-MM-DD or an ISO datetime,"
            f" got {value!r}") from None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=tz)


def parse_window(since: str, until: str | None, now: datetime,
                 tz: tzinfo) -> tuple[int, int]:
    """(since_ms, until_ms), each an epoch-ms boundary of a [since, until)
    window. `since` is required; `until` defaults to `now`. Each bound is
    either a bare date ('YYYY-MM-DD', local midnight in `tz`) or a full
    ISO datetime (naive = local `tz`, aware = honoured as given). Raises
    ChangedWindowError on unparseable input or since >= until."""
    since_dt = _parse_bound(since, tz, "since")
    until_dt = _parse_bound(until, tz, "until") if until is not None else now
    since_ms = int(since_dt.timestamp() * 1000)
    until_ms = int(until_dt.timestamp() * 1000)
    if since_ms >= until_ms:
        until_label = until if until is not None else "now"
        raise ChangedWindowError(
            f"since ({since!r}) must be before until ({until_label!r})")
    return since_ms, until_ms


def classify(created_at: int | None, since_ms: int, until_ms: int) -> str:
    """'new' when `created_at` falls inside [since_ms, until_ms), else
    'edited' (including a null created_at -- an imported/pre-existing
    block whose creation time was never recorded)."""
    if created_at is not None and since_ms <= created_at < until_ms:
        return "new"
    return "edited"


def resolve_day(word: str, today: date) -> tuple[date, date]:
    """CLI day word -> a one-day (since_date, until_date) window. `word`
    is 'today', 'yesterday', or a literal 'YYYY-MM-DD' date."""
    if word == "today":
        d = today
    elif word == "yesterday":
        d = today - timedelta(days=1)
    elif _DATE_RE.fullmatch(word):
        try:
            d = date.fromisoformat(word)
        except ValueError:
            raise ChangedWindowError(f"not a valid date: {word!r}") from None
    else:
        raise ChangedWindowError(
            f"expected today, yesterday, or YYYY-MM-DD, got {word!r}")
    return d, d + timedelta(days=1)
