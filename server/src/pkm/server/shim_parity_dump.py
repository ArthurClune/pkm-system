# pattern: Imperative Shell
"""Dump offline-shim parity fixtures (spec section 7): a deterministic
seed graph plus the exact JSON the FastAPI read routes return for a set of
requests. The TS local-API handlers (web/src/replica/localApi) replay the
same requests over a replica loaded with the same seed and must produce
identical JSON. Regenerate with:
uv run python -m pkm.server.shim_parity_dump > ../shared/fixtures/shim_parity.json
Guarded by tests/test_shim_parity_fixture.py."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import init_db, open_db

_PASSWORD = "fixture-pw"

# Deterministic seed: nested blocks, block refs, backlinks with breadcrumbs,
# an unlinked mention, a past daily page, sidebar entries. updated_at values
# drive backlink group ordering (DESC NULLS LAST).
SEED = {
    "pages": [
        [1, "Machine Learning", 1000, 5000],
        [2, "AI", 1000, 9000],
        [3, "July 10th, 2026", 1000, 3000],
        [4, "Paper", 1000, None],
        [5, "Attention Is All You Need", 1000, 8000],
    ],
    "blocks": [
        # [uid, page_id, parent_uid, order_idx, text, heading, collapsed, created, updated]
        ["uid_b1", 1, None, 0, "Tags:: #AI", None, 0, 1000, 2000],
        ["uid_b2", 1, None, 1, "Papers", 2, 0, 1000, 2000],
        ["uid_b3", 1, "uid_b2", 0, "[[Attention Is All You Need]] is a [[Paper]]",
         None, 0, 1000, 2000],
        ["uid_b4", 1, "uid_b3", 0, "deep child mentioning [[AI]]", None, 1,
         1000, 2000],
        ["uid_b5", 3, None, 0, "Studying [[Machine Learning]] today", None, 0,
         1000, 2000],
        ["uid_b6", 3, None, 1, "See ((uid_b3)) for details", None, 0, 1000, 2000],
        ["uid_b7", 2, None, 0, "AI overview mentions Machine Learning in plain text",
         None, 0, 1000, 2000],
        ["uid_b8", 5, None, 0, "Cites ((uid_b6)) which cites more", None, 0,
         1000, 2000],
    ],
    "refs": [
        ["uid_b1", 2, "attribute"],
        ["uid_b1", 2, "tag"],
        ["uid_b3", 5, "link"],
        ["uid_b3", 4, "link"],
        ["uid_b4", 2, "link"],
        ["uid_b5", 1, "link"],
    ],
    "sidebar": [
        [1, "Machine Learning", 0],
        [2, "AI", 1],
    ],
}

# Attribute rows: refs seed uses (uid_b1 -> AI) twice with different kinds
# to exercise ref-kind fan-out in backlinks (DISTINCT page grouping).

CASES = [
    ("page_with_backlinks", "/api/page/Machine%20Learning"),
    ("page_ai", "/api/page/AI"),
    ("page_daily_existing", "/api/page/July%2010th,%202026"),
    ("page_backlinks_paged", "/api/page/AI?bl_offset=1&bl_limit=1"),
    ("unlinked_ai", "/api/unlinked?title=AI"),
    ("unlinked_ml", "/api/unlinked?title=Machine%20Learning&limit=5&offset=0"),
    ("journal_pinned", "/api/journal?before=2026-07-11&days=3"),
    ("titles_a", "/api/titles?q=a"),
    ("titles_ml", "/api/titles?q=Machine"),
    ("block_refs", "/api/block-refs?uids=uid_b8,uid_missing"),
    ("sidebar", "/api/sidebar"),
    ("search_attention", "/api/search?q=attention"),
    ("search_machine", "/api/search?q=machine"),
    ("search_phrase", "/api/search?q=plain%20text"),
    ("search_empty", "/api/search?q=%20"),
]


def fixture() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "pkm.sqlite3"
        init_db(db_path)
        con = open_db(db_path)
        con.executemany("INSERT INTO pages VALUES (?,?,?,?)", SEED["pages"])
        con.executemany(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " heading, collapsed, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)", SEED["blocks"])
        con.executemany("INSERT INTO refs VALUES (?,?,?)", SEED["refs"])
        con.executemany("INSERT INTO sidebar_entries VALUES (?,?,?)",
                        SEED["sidebar"])
        con.commit()
        con.close()
        salt = bytes.fromhex("00" * 16)
        (Path(tmp) / "assets").mkdir()
        config = Config(
            db_path=db_path,
            assets_dir=Path(tmp) / "assets",
            password_salt=salt.hex(),
            password_hash=hash_password(_PASSWORD, salt),
            session_secret="cd" * 32,
            cookie_secure=False,
        )
        client = TestClient(create_app(config))
        r = client.post("/api/login", json={"password": _PASSWORD})
        assert r.status_code == 200
        cases = []
        for name, path in CASES:
            resp = client.get(path)
            assert resp.status_code == 200, f"{name}: {resp.status_code}"
            cases.append({"name": name, "path": path, "response": resp.json()})
        return {"seed": SEED, "cases": cases}


def main() -> int:
    print(json.dumps(fixture(), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
