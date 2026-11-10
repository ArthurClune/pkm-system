import ast
import subprocess
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
PROPS = SERVER / "tests" / "props"

# Files under tests/props that run on every commit, with the reason.
UNMARKED = {
    "test_model.py": "guards the property model itself on every commit",
}


def _collect(*args):
    return subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-q",
                           "--no-cov", *args, "tests/props"],
                          cwd=SERVER, capture_output=True, text=True)


def _carries_proptest_mark(path: Path) -> bool:
    """True when the module assigns `pytestmark = pytest.mark.proptest`.

    Parsed, not imported: importing would run the module's setup.
    """
    for node in ast.parse(path.read_text()).body:
        if not isinstance(node, ast.Assign):
            continue
        if any(isinstance(t, ast.Name) and t.id == "pytestmark" for t in node.targets):
            if "pytest.mark.proptest" in ast.unparse(node.value):
                return True
    return False


def _property_files() -> list[str]:
    return sorted(p.name for p in PROPS.glob("test_*.py"))


def _marked_files() -> list[str]:
    return [n for n in _property_files() if _carries_proptest_mark(PROPS / n)]


def test_every_property_file_is_marked_or_allowed():
    unmarked = [n for n in _property_files()
                if n not in _marked_files() and n not in UNMARKED]
    assert not unmarked, (
        f"tests/props files with no proptest mark and no UNMARKED entry: {unmarked}")


def test_the_unmarked_allow_list_has_no_stale_entries():
    files = set(_property_files())
    marked = set(_marked_files())
    stale = [n for n in UNMARKED if n not in files or n in marked]
    assert not stale, f"UNMARKED names a missing or already-marked file: {stale}"


def test_default_run_deselects_every_property():
    result = _collect()
    assert result.returncode == 0, result.stdout + result.stderr
    lines = [line for line in result.stdout.splitlines() if "::" in line]
    marked = _marked_files()
    assert marked
    assert not [line for line in lines if any(f in line for f in marked)]


def test_proptest_marker_selects_them():
    result = _collect("-m", "proptest")
    assert result.returncode == 0, result.stdout + result.stderr
    for name in _marked_files():
        assert f"{name}::" in result.stdout, name
