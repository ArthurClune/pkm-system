from datetime import date

import pytest

from pkm.server.daily import date_for_title, title_for_date

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
])
def test_non_daily_titles(bad):
    assert date_for_title(bad) is None
