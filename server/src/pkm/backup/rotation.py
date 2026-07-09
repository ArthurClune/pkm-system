# pattern: Functional Core
"""Which dated sqlite backups to delete: keep the newest N days plus the
latest backup of every month (kept forever)."""
from __future__ import annotations

import re
from datetime import date

_NAME_RE = re.compile(r"^pkm-(\d{4})-(\d{2})-(\d{2})\.sqlite3$")


def backup_name(day: date) -> str:
    return f"pkm-{day.isoformat()}.sqlite3"


def prune_list(names: list[str], keep_daily: int = 14) -> list[str]:
    dated: dict[date, str] = {}
    for name in names:
        m = _NAME_RE.match(name)
        if m:  # anything unparseable is left alone
            dated[date(int(m[1]), int(m[2]), int(m[3]))] = name
    days = sorted(dated)
    keep = set(days[-keep_daily:]) if keep_daily > 0 else set()
    month_latest: dict[tuple[int, int], date] = {}
    for d in days:
        month_latest[(d.year, d.month)] = d
    keep.update(month_latest.values())
    return [dated[d] for d in days if d not in keep]
