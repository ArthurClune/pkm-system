import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "icloud_backup.py"
SECRET = "ab12" * 16
NEW_SECRET = "cd34" * 16


def _load():
    spec = importlib.util.spec_from_file_location("icloud_backup", SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ib = _load()


def _config(secret=SECRET, **extra):
    cfg = {
        "db_file": "pkm.sqlite3",
        "password_salt": "00ff",
        "password_hash": "scrypt$abc",
        "session_secret": secret,
        "cookie_secure": True,
    }
    cfg.update(extra)
    return cfg


@pytest.fixture
def env(tmp_path):
    data = tmp_path / "data"
    (data / "assets").mkdir(parents=True)
    (data / "assets" / "a.txt").write_text("note")
    (data / "config.json").write_text(json.dumps(_config(), indent=2))
    snaps = tmp_path / "snaps"
    snaps.mkdir()
    dest = tmp_path / "icloud"
    return data, snaps, dest


def backup(env, today, extra=()):
    data, snaps, dest = env
    return ib.main(["backup", "--dest", str(dest), "--data-dir", str(data),
                    "--sqlite-backups", str(snaps), "--today", today, *extra])


def restore(env, date, out):
    return ib.main(["restore", "--dest", str(env[2]), "--date", date, "--out", str(out)])


def tree_has(dest, needle):
    return [p for p in dest.rglob("*") if p.is_file() and needle.encode() in p.read_bytes()]


def set_config(env, **kw):
    path = env[0] / "config.json"
    path.write_text(json.dumps(_config(**kw), indent=2))
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))


def test_first_backup_mirrors_no_secret(env):
    assert backup(env, "2026-10-01") == 0
    assert tree_has(env[2], SECRET) == []
    mirrored = json.loads((env[2] / "data/main/config.json").read_text())
    assert mirrored == {k: v for k, v in _config().items() if k != "session_secret"}


def test_incremental_after_config_change_mirrors_no_secret(env):
    backup(env, "2026-10-01")
    set_config(env, secret=NEW_SECRET, extra_setting=1)
    assert backup(env, "2026-10-02") == 0
    assert tree_has(env[2], SECRET) == []
    assert tree_has(env[2], NEW_SECRET) == []
    incr = json.loads((env[2] / "data/incr/2026-10-02/files/config.json").read_text())
    assert incr["extra_setting"] == 1 and "session_secret" not in incr


def test_unchanged_config_is_not_recopied(env):
    backup(env, "2026-10-01")
    backup(env, "2026-10-02")
    assert not (env[2] / "data/incr/2026-10-02/files/config.json").exists()


def test_fold_keeps_secret_out(env):
    backup(env, "2026-10-01")
    set_config(env, secret=NEW_SECRET)
    backup(env, "2026-10-02")
    assert backup(env, "2026-10-05", ["--keep-days", "2"]) == 0
    assert not (env[2] / "data/incr/2026-10-02").exists()
    assert tree_has(env[2], SECRET) == []
    assert tree_has(env[2], NEW_SECRET) == []


def test_restore_round_trips_and_issues_new_secret(env, tmp_path, capsys):
    backup(env, "2026-10-01")
    set_config(env, secret=NEW_SECRET, extra_setting="x")
    backup(env, "2026-10-02")
    out = tmp_path / "restored"
    assert restore(env, "2026-10-02", out) == 0
    got = json.loads((out / "config.json").read_text())
    want = _config(secret=NEW_SECRET, extra_setting="x")
    secret = got.pop("session_secret")
    want.pop("session_secret")
    assert got == want
    assert len(secret) == 64 and bytes.fromhex(secret)
    assert secret not in (SECRET, NEW_SECRET)
    assert (out / "config.json").stat().st_mode & 0o777 == 0o600
    assert (out / "assets/a.txt").read_text() == "note"
    assert "log in again" in capsys.readouterr().out


def test_restore_of_main_passes_manifest_check(env, tmp_path):
    backup(env, "2026-10-01")
    assert restore(env, "2026-10-01", tmp_path / "r") == 0


def test_restore_keeps_a_secret_already_present(env, tmp_path):
    backup(env, "2026-10-01")
    mirrored = env[2] / "data/main/config.json"
    cfg = json.loads(mirrored.read_text())
    cfg["session_secret"] = NEW_SECRET
    mirrored.write_text(json.dumps(cfg, indent=2))
    out = tmp_path / "r"
    mirror = ib.DataMirror(env[2] / "data")
    out.mkdir()
    (out / "config.json").write_text(json.dumps(cfg))
    assert mirror.ensure_secret(out) is False
    assert json.loads((out / "config.json").read_text())["session_secret"] == NEW_SECRET


@pytest.mark.parametrize("raw", ["{not json", "[1, 2]", "\xff"])
def test_unparsable_config_is_not_mirrored(env, capsys, raw):
    (env[0] / "config.json").write_bytes(raw.encode("latin-1") + SECRET.encode())
    assert backup(env, "2026-10-01") == 1
    assert "config.json NOT mirrored" in capsys.readouterr().err
    assert tree_has(env[2], SECRET) == []
    assert not (env[2] / "data/main/config.json").exists()
    assert (env[2] / "data/main/assets/a.txt").read_text() == "note"


def test_config_turning_unparsable_later_drops_the_mirrored_copy(env):
    backup(env, "2026-10-01")
    (env[0] / "config.json").write_text("{broken " + SECRET)
    assert backup(env, "2026-10-02") == 1
    assert tree_has(env[2], SECRET) == []
    assert "config.json\n" in (env[2] / "data/incr/2026-10-02/deleted.txt").read_text()


def test_script_runs_under_system_python(env, tmp_path):
    py = Path("/usr/bin/python3")
    if not py.exists():
        pytest.skip("no system python3")
    data, snaps, dest = env
    run = subprocess.run(
        [str(py), str(SCRIPT), "backup", "--dest", str(dest), "--data-dir", str(data),
         "--sqlite-backups", str(snaps), "--today", "2026-10-01"],
        capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    out = tmp_path / "r"
    run = subprocess.run(
        [str(py), str(SCRIPT), "restore", "--dest", str(dest), "--date", "2026-10-01",
         "--out", str(out)], capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    assert "session_secret" in json.loads((out / "config.json").read_text())
    assert tree_has(dest, SECRET) == []
