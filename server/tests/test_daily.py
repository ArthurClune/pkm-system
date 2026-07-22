from datetime import date

import pytest

from pkm.server.daily import (
    date_for_title, is_page_empty, past_week_dates, select_journal_days,
    title_for_date)

CASES = [
    (date(2026, 7, 1), "July 1st, 2026"),
    (date(2026, 7, 2), "July 2nd, 2026"),
    (date(2026, 7, 3), "July 3rd, 2026"),
    (date(2026, 7, 4), "July 4th, 2026"),
    (date(2026, 7, 11), "July 11th, 2026"),
    (date(2026, 7, 12), "July 12th, 2026"),
    (date(2026, 7, 13), "July 13th, 2026"),
    (date(2026, 7, 21), "July 21st, 2026"),
    (date(2026, 7, 22), "July 22nd, 2026"),
    (date(2026, 7, 23), "July 23rd, 2026"),
    (date(2026, 1, 31), "January 31st, 2026"),
]


@pytest.mark.parametrize("d,title", CASES)
def test_roundtrip(d, title):
    assert title_for_date(d) == title
    assert date_for_title(title) == d


@pytest.mark.parametrize("bad", [
    "Machine Learning", "July 2026", "July 32nd, 2026",
    "Smarch 1st, 2026", "July 1st 2026", "AWS/SCP",
    "July 1nd, 2026", "July 3th, 2026",
])
def test_non_daily_titles(bad):
    assert date_for_title(bad) is None


def test_past_week_dates_is_the_seven_days_before_today():
    assert past_week_dates(date(2026, 7, 12)) == [
        date(2026, 7, 11), date(2026, 7, 10), date(2026, 7, 9),
        date(2026, 7, 8), date(2026, 7, 7), date(2026, 7, 6),
        date(2026, 7, 5),
    ]


def test_past_week_dates_crosses_month_boundary():
    assert past_week_dates(date(2026, 7, 3))[-1] == date(2026, 6, 26)


@pytest.mark.parametrize("texts,empty", [
    ([], True),
    (["", "   ", "\t\n"], True),
    (["hello"], False),
    (["", "x", "  "], False),
])
def test_is_page_empty(texts, empty):
    assert is_page_empty(texts) is empty


NONEMPTY = {date(2026, 7, 14), date(2026, 7, 9), date(2026, 7, 2),
            date(2026, 7, 22)}


def test_select_journal_days_head_is_today_then_recent_nonempty():
    # today leads even when empty (composing); gaps are skipped
    assert select_journal_days(NONEMPTY, today=date(2026, 7, 22),
                               before=None, limit=3) == [
        date(2026, 7, 22), date(2026, 7, 14), date(2026, 7, 9)]


def test_select_journal_days_head_does_not_duplicate_nonempty_today():
    days = select_journal_days(NONEMPTY, today=date(2026, 7, 22),
                               before=None, limit=5)
    assert days == [date(2026, 7, 22), date(2026, 7, 14),
                    date(2026, 7, 9), date(2026, 7, 2)]


def test_select_journal_days_head_when_today_is_empty():
    assert select_journal_days({date(2026, 7, 14)}, today=date(2026, 7, 22),
                               before=None, limit=5) == [
        date(2026, 7, 22), date(2026, 7, 14)]


def test_select_journal_days_head_limit_one_is_just_today():
    assert select_journal_days(NONEMPTY, today=date(2026, 7, 22),
                               before=None, limit=1) == [date(2026, 7, 22)]


def test_select_journal_days_cursor_is_exclusive_newest_first():
    assert select_journal_days(NONEMPTY, today=date(2026, 7, 22),
                               before=date(2026, 7, 14), limit=5) == [
        date(2026, 7, 9), date(2026, 7, 2)]


def test_select_journal_days_cursor_returns_fewer_when_exhausted():
    assert select_journal_days(NONEMPTY, today=date(2026, 7, 22),
                               before=date(2026, 7, 2), limit=5) == []
