from datetime import date, timedelta

from pkm.backup.rotation import backup_name, prune_list


def names(start: date, days: int) -> list[str]:
    return [backup_name(start + timedelta(d)) for d in range(days)]


def test_backup_name():
    assert backup_name(date(2026, 7, 9)) == "pkm-2026-07-09.sqlite3"


def test_under_keep_daily_deletes_nothing():
    assert prune_list(names(date(2026, 7, 1), 14)) == []


def test_keeps_newest_14_and_month_ends():
    # 2026-06-20 .. 2026-07-20: 31 files. Keep 07-07..07-20 (newest 14)
    # plus 06-30 (last of June). Everything else goes.
    got = prune_list(names(date(2026, 6, 20), 31))
    assert backup_name(date(2026, 6, 30)) not in got
    assert backup_name(date(2026, 6, 29)) in got
    assert backup_name(date(2026, 7, 6)) in got
    assert backup_name(date(2026, 7, 7)) not in got
    assert len(got) == 31 - 14 - 1


def test_last_of_month_means_latest_existing_backup_that_month():
    # only two June files exist; the 15th is June's latest -> kept forever
    files = [backup_name(date(2026, 6, 1)), backup_name(date(2026, 6, 15)),
             *names(date(2026, 7, 1), 14)]
    got = prune_list(files)
    assert got == [backup_name(date(2026, 6, 1))]


def test_unparseable_names_are_never_deleted():
    files = ["pkm-2026-07-09.sqlite3.tmp", "notes.txt",
             *names(date(2026, 7, 1), 20)]
    got = prune_list(files)
    assert "notes.txt" not in got and "pkm-2026-07-09.sqlite3.tmp" not in got
