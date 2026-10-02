import subprocess
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]


def _collect(*args):
    return subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-q",
                           "--no-cov", *args, "tests/props"],
                          cwd=SERVER, capture_output=True, text=True)


PROPERTY_FILES = ("test_smoke_props.py", "test_ops_state.py", "test_planner_props.py")


def test_default_run_deselects_every_property():
    # test_model.py lives in props/ unmarked on purpose: it guards the model on every commit
    result = _collect()
    assert result.returncode == 0, result.stdout + result.stderr
    lines = [line for line in result.stdout.splitlines() if "::" in line]
    assert not any(f in line for line in lines for f in PROPERTY_FILES)


def test_proptest_marker_selects_them():
    result = _collect("-m", "proptest")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "test_smoke_props.py::" in result.stdout
