import json
import os
import stat
from pathlib import Path

import pytest

from pkm.server import setup


def test_config_is_never_wider_than_owner_only_even_under_umask_zero(
        monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    old = os.umask(0)
    seen: list[int] = []
    real_chmod = Path.chmod
    real_replace = os.replace

    def observe_dir() -> None:
        for p in (tmp_path / "d").iterdir():
            seen.append(stat.S_IMODE(p.stat().st_mode))

    def spy_chmod(self: Path, mode: int, **kw: bool) -> None:
        observe_dir()
        real_chmod(self, mode, **kw)

    def spy_replace(src: str | Path, dst: str | Path) -> None:
        observe_dir()
        real_replace(src, dst)

    monkeypatch.setattr(Path, "chmod", spy_chmod)
    monkeypatch.setattr(os, "replace", spy_replace)
    try:
        setup.main(["--data-dir", str(tmp_path / "d"), "--password", "pw"])
    finally:
        os.umask(old)
    cfg = tmp_path / "d" / "config.json"
    assert stat.S_IMODE(cfg.stat().st_mode) == 0o600
    assert json.loads(cfg.read_text())["db_file"] == "pkm.sqlite3"
    assert seen and all(m & 0o077 == 0 for m in seen)
    assert [p.name for p in (tmp_path / "d").iterdir()] == ["config.json"]
