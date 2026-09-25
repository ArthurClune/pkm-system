"""Pure window parsing/classification for pkm-6eea (pkm changed)."""
from datetime import date, datetime, timedelta, timezone

import pytest

from pkm.changed import ChangedWindowError, classify, parse_window, resolve_day

TZ = timezone(timedelta(hours=1))  # a fixed non-UTC offset, so a test that
                                    # forgets to convert fails loudly.
NOW = datetime(2026, 9, 25, 15, 30, tzinfo=TZ)


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def test_since_date_is_local_midnight():
    since_ms, until_ms = parse_window("2026-09-24", None, NOW, TZ)
    assert since_ms == _ms(datetime(2026, 9, 24, 0, 0, tzinfo=TZ))
    assert until_ms == _ms(NOW)


def test_until_date_is_local_midnight_exclusive():
    since_ms, until_ms = parse_window("2026-09-23", "2026-09-24", NOW, TZ)
    assert until_ms == _ms(datetime(2026, 9, 24, 0, 0, tzinfo=TZ))


def test_until_defaults_to_now():
    _, until_ms = parse_window("2026-09-01", None, NOW, TZ)
    assert until_ms == _ms(NOW)


def test_naive_datetime_is_local_time():
    since_ms, _ = parse_window("2026-09-24T09:15:00", None, NOW, TZ)
    assert since_ms == _ms(datetime(2026, 9, 24, 9, 15, tzinfo=TZ))


def test_aware_datetime_is_honoured_as_given():
    other_tz = timezone(timedelta(hours=-5))
    since_ms, _ = parse_window("2026-09-24T09:15:00-05:00", None, NOW, TZ)
    assert since_ms == _ms(datetime(2026, 9, 24, 9, 15, tzinfo=other_tz))


def test_unparseable_since_raises_actionable_error():
    with pytest.raises(ChangedWindowError, match="since"):
        parse_window("not-a-date", None, NOW, TZ)


def test_unparseable_until_raises_actionable_error():
    with pytest.raises(ChangedWindowError, match="until"):
        parse_window("2026-09-01", "not-a-date", NOW, TZ)


def test_since_equal_until_raises():
    with pytest.raises(ChangedWindowError, match="since|until"):
        parse_window("2026-09-24", "2026-09-24", NOW, TZ)


def test_since_after_until_raises():
    with pytest.raises(ChangedWindowError):
        parse_window("2026-09-25", "2026-09-24", NOW, TZ)


def test_classify_new_when_created_in_window():
    assert classify(1_000, 500, 1_500) == "new"


def test_classify_new_is_inclusive_of_since():
    assert classify(500, 500, 1_500) == "new"


def test_classify_edited_when_created_at_or_after_until():
    assert classify(1_500, 500, 1_500) == "edited"


def test_classify_edited_when_created_before_since():
    assert classify(100, 500, 1_500) == "edited"


def test_classify_edited_when_created_at_is_none():
    assert classify(None, 500, 1_500) == "edited"


def test_resolve_day_today():
    today = date(2026, 9, 25)
    assert resolve_day("today", today) == (today, date(2026, 9, 26))


def test_resolve_day_yesterday():
    today = date(2026, 9, 25)
    assert resolve_day("yesterday", today) == (date(2026, 9, 24), today)


def test_resolve_day_explicit_date():
    today = date(2026, 9, 25)
    assert resolve_day("2026-01-05", today) == (date(2026, 1, 5), date(2026, 1, 6))


def test_resolve_day_rejects_unknown_word():
    with pytest.raises(ChangedWindowError):
        resolve_day("tomorrow", date(2026, 9, 25))


def test_resolve_day_rejects_bad_date():
    with pytest.raises(ChangedWindowError):
        resolve_day("2026-13-40", date(2026, 9, 25))
