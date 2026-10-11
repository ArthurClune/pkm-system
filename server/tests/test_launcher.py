"""The Swift launcher that is the launchd job: spawn-and-wait, signal
forwarding, status passthrough."""

import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BUILD = REPO / "deploy" / "launcher" / "build.sh"

pytestmark = pytest.mark.skipif(
    shutil.which("swiftc") is None or shutil.which("codesign") is None,
    reason="swiftc and codesign are required to build the launcher",
)

TIMEOUT = 15


@pytest.fixture(scope="module")
def launcher(tmp_path_factory: pytest.TempPathFactory) -> str:
    out = tmp_path_factory.mktemp("launcher") / "pkm-server"
    subprocess.run([str(BUILD), str(out)], check=True, timeout=300)
    return str(out)


def run(launcher: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [launcher, *args], capture_output=True, text=True, timeout=TIMEOUT
    )


def test_no_args_prints_usage_and_exits_64(launcher: str) -> None:
    r = run(launcher)
    assert r.returncode == 64
    assert "usage" in r.stderr.lower()


def test_exit_code_passes_through(launcher: str) -> None:
    assert run(launcher, "/bin/sh", "-c", "exit 7").returncode == 7


def test_child_killed_by_signal_yields_128_plus_signal(launcher: str) -> None:
    assert run(launcher, "/bin/sh", "-c", "kill -KILL $$").returncode == 137


def test_missing_program_exits_127_naming_it(launcher: str) -> None:
    r = run(launcher, "/nonexistent/pkm-no-such-program")
    assert r.returncode == 127
    assert "/nonexistent/pkm-no-such-program" in r.stderr


def test_program_is_resolved_on_path(launcher: str) -> None:
    assert run(launcher, "sh", "-c", "exit 5").returncode == 5


def test_launcher_stays_the_parent(launcher: str, tmp_path: Path) -> None:
    out = tmp_path / "ppid"
    proc = subprocess.Popen(
        [
            launcher,
            sys.executable,
            "-c",
            f"import os; open({str(out)!r}, 'w').write(str(os.getppid()))",
        ]
    )
    assert proc.wait(timeout=TIMEOUT) == 0
    assert int(out.read_text()) == proc.pid


def test_child_starts_with_default_dispositions(
    launcher: str, tmp_path: Path
) -> None:
    out = tmp_path / "disp"
    code = (
        "import signal;"
        "d=[signal.getsignal(signal.SIGHUP)==signal.SIG_DFL,"
        # Python installs its own SIGINT handler over SIG_DFL; it only skips
        # that when SIGINT was inherited as ignored.
        "signal.getsignal(signal.SIGINT)!=signal.SIG_IGN,"
        "signal.getsignal(signal.SIGTERM)==signal.SIG_DFL];"
        f"open({str(out)!r}, 'w').write(repr(d))"
    )
    assert run(launcher, sys.executable, "-c", code).returncode == 0
    assert out.read_text() == "[True, True, True]"


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT, signal.SIGHUP])
def test_signal_reaches_child_and_launcher_waits_for_it(
    launcher: str, tmp_path: Path, sig: signal.Signals
) -> None:
    ready = tmp_path / "ready"
    marker = tmp_path / "marker"
    code = (
        "import signal, sys, time\n"
        "def h(*_):\n"
        "    time.sleep(0.5)\n"
        f"    open({str(marker)!r}, 'w').write('x')\n"
        "    sys.exit(3)\n"
        f"signal.signal({int(sig)}, h)\n"
        f"open({str(ready)!r}, 'w').write('1')\n"
        "time.sleep(30)\n"
    )
    proc = subprocess.Popen([launcher, sys.executable, "-c", code])
    try:
        deadline = time.monotonic() + TIMEOUT
        while not ready.exists():
            assert time.monotonic() < deadline, "child never became ready"
            time.sleep(0.05)
        os.kill(proc.pid, sig)
        assert proc.wait(timeout=TIMEOUT) == 3
        assert marker.exists()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_child_starts_with_an_empty_signal_mask(
    launcher: str, tmp_path: Path
) -> None:
    out = tmp_path / "mask"

    def block() -> None:
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGUSR1})

    code = (
        "import signal;"
        f"open({str(out)!r}, 'w').write("
        "repr(sorted(signal.pthread_sigmask(signal.SIG_BLOCK, set()))))"
    )
    proc = subprocess.Popen([launcher, sys.executable, "-c", code], preexec_fn=block)
    assert proc.wait(timeout=TIMEOUT) == 0
    assert out.read_text() == "[]"


def test_signal_during_startup_is_never_lost(launcher: str) -> None:
    """A SIGTERM at any instant either kills the launcher before it spawns or
    reaches the child; it is never dropped while the child keeps running."""
    for i in range(200):
        proc = subprocess.Popen([launcher, "/bin/sleep", "5"])
        spin_until = time.perf_counter() + (i % 50) * 0.0001
        while time.perf_counter() < spin_until:
            pass
        proc.send_signal(signal.SIGTERM)
        try:
            rc = proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            pytest.fail(f"SIGTERM lost on iteration {i}")
        assert rc in (-signal.SIGTERM, 128 + signal.SIGTERM)
