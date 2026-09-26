# pattern: Imperative Shell
"""Backend perf check: fixed API scenarios, in-process, against the fixture.

Per scenario: two counted runs (tracer + progress handler on; they must
agree, else the count is not gateable) then one warm-up and `repeats` timed
runs with no instrumentation. Writes run against a fresh copy of the
fixture every time so they never accumulate."""
from __future__ import annotations

import argparse
import json
import platform
import shutil
import sqlite3
import statistics
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import time_machine
from fastapi.testclient import TestClient

from pkm.describe.service import DescribeService
from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import get_db

from perfcheck.build import cached_fixture, fixture_hash
from perfcheck.fixture import FROZEN_NOW, Landmarks, generate
from perfcheck.sqlplan import aliases, full_scans, plannable
from perfcheck.trace import Tracer

PASSWORD = "perf-pw"
SALT = bytes.fromhex("22" * 16)


class UnstableCountError(RuntimeError):
    pass


@dataclass(frozen=True)
class Scenario:
    name: str
    method: str
    path: str
    params: dict | None = None
    body: dict | None = None
    writes: bool = False


def scenarios(lm: Landmarks, max_seq: int) -> list[Scenario]:
    def g(name: str, path: str, **params: object) -> Scenario:
        return Scenario(name, "GET", path, params or None)

    paste = [{"op": "create", "uid": "pp00000000", "page_title": lm.big_page,
              "parent_uid": None, "order_idx": 0, "text": "pasted parent"}]
    paste += [{"op": "create", "uid": f"pp{i:08d}", "page_title": lm.big_page,
               "parent_uid": "pp00000000", "order_idx": i - 1, "text": f"pasted line {i} project"}
              for i in range(1, 50)]

    def batch(ops: list[dict]) -> dict:
        return {"client_id": "perf-check", "batch_id": "perfcheck-000001", "ops": ops}

    return [
        g("page/big", f"/api/page/{lm.big_page}"),
        g("page/hub", f"/api/page/{lm.hub}"),
        g("page/hub-deep", f"/api/page/{lm.hub}", bl_offset=200, bl_limit=20),
        g("page/journal-day", f"/api/page/{lm.journal_day}"),
        g("journal/head", "/api/journal"),
        g("journal/before", "/api/journal", before="2026-03-01", days=7),
        g("block/get", f"/api/block/{lm.edit_uid}"),
        g("block/backlinks", f"/api/block/{lm.popular_uid}/backlinks"),
        g("block-refs/30", "/api/block-refs", uids=",".join(lm.ref_uids)),
        g("unlinked/hub", "/api/unlinked", title=lm.hub),
        g("search/common", "/api/search", q="project"),
        g("search/rare", "/api/search", q="zyxquark"),
        g("search/prefix", "/api/search", q="synchro"),
        g("search/phrase", "/api/search", q="quantum lattice", exact="true"),
        g("search/many-hits", "/api/search", q="project", limit=100),
        g("search/title", "/api/search", q="Topic"),
        g("titles/prefix", "/api/titles", q="Top"),
        g("titles/infix", "/api/titles", q="pha"),
        g("assets/search", "/api/assets/search", q="diagram", type="image"),
        g("assets/range", "/api/assets/search",
          from_ms=int(FROZEN_NOW.timestamp() * 1000) - 180 * 86_400_000),
        g("todos/all", "/api/todos"),
        g("changed/week", "/api/changed", since="2026-06-08"),
        g("query/and-not", "/api/query", expr=f"{{and: [[{lm.hub}]] {{not: [[Hub Beta]]}}}}"),
        g("sidebar", "/api/sidebar"),
        g("sync/snapshot", "/api/sync/snapshot"),
        g("sync/changes-mid", "/api/sync/changes", since=max_seq // 2),
        Scenario("ops/edit-1", "POST", "/api/ops", body=batch(
            [{"op": "update_text", "uid": lm.edit_uid, "text": "edited by the perf check"}]), writes=True),
        Scenario("ops/paste-50", "POST", "/api/ops", body=batch(paste), writes=True),
        Scenario("ops/move-subtree", "POST", "/api/ops", body=batch(
            [{"op": "move", "uid": lm.move_uid, "parent_uid": None, "order_idx": 0,
              "page_title": lm.hub}]), writes=True),
        Scenario("rename/hub", "POST", f"/api/page/{lm.hub}/rename",
                 body={"new_title": f"{lm.hub} Renamed"}, writes=True),
    ]


def make_client(db_path: Path, tracer: Tracer) -> TestClient:
    data = db_path.parent
    config = Config(db_path=db_path, assets_dir=data / "assets",
                    password_salt=SALT.hex(), password_hash=hash_password(PASSWORD, SALT),
                    session_secret="ab" * 32, cookie_secure=False,
                    openai_api_key_file=data / "no-openai", zai_api_key_file=data / "no-zai",
                    goodlinks_api_key_file=data / "no-goodlinks")
    describe = DescribeService(config, None, "disabled for perf check")
    app = create_app(config, describe_service=describe)
    app.dependency_overrides[get_db] = tracer.get_db
    client = TestClient(app)  # no `with`: lifespan (background workers) never starts
    r = client.post("/api/login", json={"password": PASSWORD})
    r.raise_for_status()
    return client


def _call(client: TestClient, s: Scenario):
    r = client.request(s.method, s.path, params=s.params, json=s.body)
    if r.status_code != 200:
        raise RuntimeError(f"{s.name}: HTTP {r.status_code} {r.text[:300]}")
    return r


class _Env:
    """A private copy of the fixture per scenario run (fresh for writes)."""

    def __init__(self, fixture_db: Path) -> None:
        self.fixture_db = fixture_db
        self.dir = Path(tempfile.mkdtemp(prefix="pkm-perf-"))
        (self.dir / "assets").mkdir()
        self.tracer = Tracer()
        self.db = self.dir / "pkm.sqlite3"
        self.fresh()
        self.client = make_client(self.db, self.tracer)

    def fresh(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            Path(f"{self.db}{suffix}").unlink(missing_ok=True)
        shutil.copyfile(self.fixture_db, self.db)

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


def _count_once(env: _Env, s: Scenario, tables: set[str]) -> dict:
    if s.writes:
        env.fresh()
    env.tracer.start()
    r = _call(env.client, s)
    tally = env.tracer.stop()
    con = sqlite3.connect(env.db)
    try:
        scans = 0
        for sql in dict.fromkeys(q for q in tally.statements if plannable(q)):
            try:
                rows = con.execute(f"EXPLAIN QUERY PLAN {sql}").fetchall()
            except sqlite3.Error as e:
                raise RuntimeError(f"{s.name}: cannot plan traced statement ({e}): {sql[:300]}") from e
            scans += len(full_scans((row[3] for row in rows), tables, aliases(sql)))
    finally:
        con.close()
    return {"statements": len(tally.statements), "trigger_statements": tally.trigger_statements,
            "vm_steps_k": tally.ticks, "bytes": len(r.content), "full_scans": scans}


def _time(env: _Env, s: Scenario, repeats: int) -> float:
    samples = []
    for i in range(repeats + 1):  # first is warm-up
        if s.writes:
            env.fresh()
        t0 = time.perf_counter()
        _call(env.client, s)
        if i:
            samples.append((time.perf_counter() - t0) * 1000)
    return round(statistics.median(samples), 2)


def run(fixture_db: Path, *, only: set[str] | None = None, repeats: int = 5,
        scale: float = 1.0, commit: str = "working-tree") -> dict:
    fx = generate(1, scale)
    # the cached fixture is shared by every session and never changes once
    # built: read-only, and immutable so no -wal/-shm is left beside it
    con = sqlite3.connect(f"{fixture_db.resolve().as_uri()}?mode=ro&immutable=1", uri=True)
    max_seq = con.execute("SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    con.close()
    out: dict[str, dict] = {}
    with time_machine.travel(FROZEN_NOW, tick=False):
        env = _Env(fixture_db)
        try:
            for s in scenarios(fx.landmarks, max_seq):
                if only is not None and s.name not in only:
                    continue
                a, b = _count_once(env, s, tables), _count_once(env, s, tables)
                if a != b:
                    raise UnstableCountError(f"{s.name}: counted runs differ: {a} vs {b}")
                metrics = {k: {"class": "exact", "value": v} for k, v in a.items()}
                metrics["median_ms"] = {"class": "timing", "value": _time(env, s, repeats)}
                out[s.name] = metrics
        finally:
            env.close()
    return {"commit": commit, "fixture_hash": fixture_hash(),
            "env": {"python": platform.python_version(), "sqlite": sqlite3.sqlite_version},
            "scenarios": out}


def main() -> int:
    ap = argparse.ArgumentParser(prog="python -m perfcheck.backend")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--commit", default="working-tree")
    a = ap.parse_args()
    only = set(a.only.split(",")) if a.only else None
    result = run(cached_fixture(1, a.scale), only=only, repeats=a.repeats,
                 scale=a.scale, commit=a.commit)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = a.out.with_suffix(".tmp")
    tmp.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    tmp.replace(a.out)  # never a partial result file
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
