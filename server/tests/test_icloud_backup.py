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
    old_style = json.dumps(_config(secret=NEW_SECRET), indent=2).encode()
    mirrored.write_bytes(old_style)
    manifest = env[2] / "data/main.manifest.json"
    obj = json.loads(manifest.read_text())
    obj["files"]["config.json"][0] = len(old_style)
    manifest.write_text(json.dumps(obj))
    out = tmp_path / "r"
    assert restore(env, "2026-10-01", out) == 0
    assert json.loads((out / "config.json").read_text())["session_secret"] == NEW_SECRET


@pytest.mark.parametrize("raw", ["{not json", "[1, 2]", "\xff"])
def test_unparsable_config_is_not_mirrored(env, capsys, raw):
    (env[0] / "config.json").write_bytes(raw.encode("latin-1") + SECRET.encode())
    assert backup(env, "2026-10-01") == 1
    assert "config.json NOT mirrored" in capsys.readouterr().err
    assert tree_has(env[2], SECRET) == []
    assert not (env[2] / "data/main/config.json").exists()
    assert (env[2] / "data/main/assets/a.txt").read_text() == "note"


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


def test_config_new_to_the_mirror_arrives_in_an_incremental(env, tmp_path):
    data = env[0]
    live = (data / "config.json").read_bytes()
    (data / "config.json").unlink()
    backup(env, "2026-10-01")
    backup(env, "2026-10-02")
    (data / "config.json").write_bytes(live)
    assert backup(env, "2026-10-03") == 0
    assert tree_has(env[2], SECRET) == []
    assert (env[2] / "data/incr/2026-10-03/files/config.json").exists()
    out = tmp_path / "r"
    assert restore(env, "2026-10-03", out) == 0
    assert "session_secret" in json.loads((out / "config.json").read_text())


def _plant_copy(data, name):
    path = data / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_config()))


def _plant_hardlink(data, name):
    path = data / name
    path.parent.mkdir(parents=True, exist_ok=True)
    os.link(data / "config.json", path)


def _plant_symlink(data, name):
    (data / name).symlink_to(data / "config.json")


def _plant_straddle(data, name):
    # CHUNK is monkeypatched to 100; the secret spans bytes 70..134
    (data / name).write_bytes(b"x" * 70 + SECRET.encode() + b"y" * 70)


def _plant_upper(data, name):
    (data / name).write_text(SECRET.upper())


LEAKY = [
    ("config copy.json", _plant_copy), ("config 2.json", _plant_copy),
    ("config.bak", _plant_copy), ("#config.json#", _plant_copy),
    ("CONFIG.JSON.bak", _plant_copy), ("assets/config.json", _plant_copy),
    ("assets/cfg.bin", _plant_hardlink), ("assets/link.json", _plant_symlink),
    ("assets/big.bin", _plant_straddle), ("assets/up.txt", _plant_upper),
    ("config.json.bak-x", _plant_copy), (".config.json.abc.tmp", _plant_copy),
]


@pytest.mark.parametrize("name,plant", LEAKY, ids=[n for n, _ in LEAKY])
def test_no_file_holding_the_secret_is_mirrored(env, monkeypatch, name, plant):
    monkeypatch.setattr(ib, "CHUNK", 100)
    plant(env[0], name)
    assert backup(env, "2026-10-01") in (0, 1)
    backup(env, "2026-10-02")
    plant(env[0], name + ".later" if "/" not in name else name.replace(".", "-l.", 1))
    backup(env, "2026-10-03")
    assert tree_has(env[2], SECRET) == []
    assert tree_has(env[2], SECRET.upper()) == []
    assert (env[2] / "data/main/config.json").exists()


def test_a_leaking_file_exits_1_and_says_partial(env, capsys):
    _plant_copy(env[0], "assets/c copy.json")
    assert backup(env, "2026-10-01") == 1
    cap = capsys.readouterr()
    assert "NOT mirrored" in cap.err and "PARTIAL" in cap.out
    assert not (env[2] / "data/main/assets/c copy.json").exists()
    assert (env[2] / "data/main/assets/a.txt").exists()


def test_leak_manifest_stays_restorable(env, tmp_path):
    _plant_copy(env[0], "assets/c copy.json")
    backup(env, "2026-10-01")
    assert restore(env, "2026-10-01", tmp_path / "r") == 0


def test_uppercase_config_name_is_redacted(env):
    (env[0] / "config.json").rename(env[0] / "Config.json")
    assert backup(env, "2026-10-01") == 0
    assert tree_has(env[2], SECRET) == []
    assert (env[2] / "data/main/Config.json").exists()


@pytest.mark.parametrize("breaker", ["chmod", "deep"])
def test_unreadable_or_pathological_config_is_not_mirrored(env, capsys, breaker):
    cfg = env[0] / "config.json"
    if breaker == "chmod":
        cfg.chmod(0)
        if os.access(cfg, os.R_OK):
            pytest.skip("running as a user that ignores modes")
    else:
        cfg.write_text("[" * 100000)
    try:
        assert backup(env, "2026-10-01") == 1
    finally:
        cfg.chmod(0o600)
    assert "NOT mirrored" in capsys.readouterr().err
    assert (env[2] / "data/main/assets/a.txt").exists()
    assert not (env[2] / "data/main/config.json").exists()


def test_failing_config_keeps_last_good_copy_in_that_days_snapshot(env, tmp_path):
    backup(env, "2026-10-01")
    (env[0] / "config.json").write_text("{trunc " + SECRET)
    assert backup(env, "2026-10-02") == 1
    set_config(env, extra_setting=2)
    assert backup(env, "2026-10-03") == 0
    for day, extra in (("2026-10-01", None), ("2026-10-02", None), ("2026-10-03", 2)):
        out = tmp_path / day
        assert restore(env, day, out) == 0
        got = json.loads((out / "config.json").read_text())
        assert got.get("extra_setting") == extra
    assert tree_has(env[2], SECRET) == []


@pytest.mark.parametrize("name", ["config.jsonl", "assets/config.json5", "config.json.md"])
def test_config_named_files_without_the_secret_are_mirrored(env, tmp_path, name):
    (env[0] / name).write_text("harmless")
    assert backup(env, "2026-10-01") == 0
    out = tmp_path / "r"
    assert restore(env, "2026-10-01", out) == 0
    assert (out / name).read_text() == "harmless"


@pytest.mark.parametrize("odd", ["e", "password"])
def test_odd_secret_is_still_redacted_and_does_not_block_other_files(env, capsys, odd):
    (env[0] / "config.json").write_text(json.dumps(_config(secret=odd)))
    (env[0] / "assets/note.txt").write_text("the password is here, e e e")
    assert backup(env, "2026-10-01") == 0
    cap = capsys.readouterr()
    assert "not 64 hex" in cap.err
    assert "session_secret" not in json.loads((env[2] / "data/main/config.json").read_text())
    assert (env[2] / "data/main/assets/note.txt").exists()


def test_odd_secret_in_an_unparsable_config_warns_too(env, capsys):
    (env[0] / "config.json").write_text('{"session_secret": "e", broken')
    assert backup(env, "2026-10-01") == 1
    assert "not 64 hex" in capsys.readouterr().err


def test_skipped_symlink_is_reported(env, capsys):
    (env[0] / "assets/ln").symlink_to(env[0] / "assets/a.txt")
    assert backup(env, "2026-10-01") == 0
    assert "skipping symlink assets/ln" in capsys.readouterr().err
