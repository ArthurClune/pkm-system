import re
from pathlib import Path

from pkm import regen

SRC = Path(__file__).resolve().parents[1] / "src"
BACKEND_MD = Path(__file__).resolve().parents[2] / "docs" / "architecture" / "backend.md"


def _dump_modules() -> set[str]:
    return {".".join(p.relative_to(SRC).with_suffix("").parts)
            for p in (SRC / "pkm").rglob("*_dump.py")}


def test_every_dump_module_is_a_step():
    stepped = {s.module for s in regen.STEPS if s.module}
    assert _dump_modules() <= stepped, sorted(_dump_modules() - stepped)


def test_tag_chars_runs_in_plain_mode_only():
    steps = [s for s in regen.STEPS if s.module == "pkm.tag_chars_dump"]
    assert len(steps) == 1 and steps[0].args == ()


def test_every_update_fixture_in_backend_md_is_a_step():
    named = set(re.findall(r"UPDATE_[A-Z_]+_FIXTURE", BACKEND_MD.read_text()))
    stepped = {s.env for s in regen.STEPS if s.env}
    assert named and named <= stepped, sorted(named - stepped)


def test_openapi_is_written_before_types_are_generated():
    names = [s.name for s in regen.STEPS]
    assert names.index("openapi") < names.index("gen-types")


def test_every_stdout_step_names_a_target_under_the_repo():
    for s in regen.STEPS:
        if s.module and s.target:
            assert not Path(s.target).is_absolute()
            assert (regen.REPO / s.target).parent.is_dir(), s.target


def test_a_failing_step_is_named_and_stops_the_run(monkeypatch, capsys):
    ran = []

    def fake(step):
        ran.append(step.name)
        return 1 if step.name == regen.STEPS[1].name else 0

    monkeypatch.setattr(regen, "run_step", fake)
    assert regen.main() == 1
    assert ran == [regen.STEPS[0].name, regen.STEPS[1].name]
    assert regen.STEPS[1].name in capsys.readouterr().err
