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
    lines = [line for line in _collect().stdout.splitlines() if "::" in line]
    assert not any(f in line for line in lines for f in PROPERTY_FILES)


def test_proptest_marker_selects_them():
    out = _collect("-m", "proptest").stdout
    assert "test_smoke_props.py::" in out
