import threading
import time

import pytest

from pkm.server.local_open import OpenProber


class BlockingOpener:
    """Opener that blocks per path until released; counts calls."""

    def __init__(self):
        self.calls = []
        self.gates: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def gate(self, path):
        with self._lock:
            return self.gates.setdefault(str(path), threading.Event())

    def __call__(self, path):
        with self._lock:
            self.calls.append(str(path))
        self.gate(path).wait(10)

    def release_all(self):
        for g in list(self.gates.values()):
            g.set()


@pytest.fixture
def opener():
    o = BlockingOpener()
    yield o
    o.release_all()


def _wait_until(pred, timeout=2.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


def test_ok_when_opener_returns():
    p = OpenProber(opener=lambda path: None, timeout=1, cap=2)
    assert p.probe("/a") == "ok"


def test_blocked_opener_times_out_unreadable(opener):
    p = OpenProber(opener=opener, timeout=0.2, cap=2)
    t0 = time.monotonic()
    assert p.probe("/a") == "unreadable"
    assert time.monotonic() - t0 < 1.5


def test_same_path_while_blocked_starts_no_second_thread(opener):
    p = OpenProber(opener=opener, timeout=0.1, cap=2)
    assert p.probe("/a") == "unreadable"
    assert p.probe("/a") == "unreadable"
    assert opener.calls == ["/a"]


def test_cap_returns_busy_without_calling_opener(opener):
    p = OpenProber(opener=opener, timeout=0.1, cap=2)
    p.probe("/a")
    p.probe("/b")
    assert p.probe("/c") == "busy"
    assert sorted(opener.calls) == ["/a", "/b"]


def test_release_frees_slot(opener):
    p = OpenProber(opener=opener, timeout=0.1, cap=1)
    assert p.probe("/a") == "unreadable"
    assert p.probe("/b") == "busy"
    opener.gate("/a").set()
    assert _wait_until(lambda: p.probe("/b") != "busy")
    opener.gate("/b").set()
    opener.gate("/c").set()
    assert _wait_until(lambda: p.probe("/c") == "ok")


def test_slot_frees_and_new_probe_ok_after_release(opener):
    p = OpenProber(opener=opener, timeout=0.1, cap=1)
    p.probe("/a")
    opener.gate("/a").set()
    opener.gate("/b").set()
    assert _wait_until(lambda: p.probe("/b") == "ok")


@pytest.mark.parametrize("exc", [PermissionError(1, "no"), OSError(5, "io")])
def test_oserror_is_unreadable(exc):
    def boom(path):
        raise exc
    assert OpenProber(opener=boom, timeout=1, cap=2).probe("/a") == "unreadable"


def test_probe_threads_are_daemon(opener):
    p = OpenProber(opener=opener, timeout=0.1, cap=2)
    p.probe("/a")
    threads = [t for t in threading.enumerate() if t.name.startswith("local-open-probe")]
    assert threads and all(t.daemon for t in threads)


def test_real_opener_reads_a_real_file(tmp_path):
    f = tmp_path / "x.txt"
    f.write_text("hi")
    assert OpenProber().probe(f) == "ok"
    assert OpenProber().probe(tmp_path / "nope") == "unreadable"


def test_known_stuck_path_answers_at_once(opener):
    p = OpenProber(opener=opener, timeout=0.3, cap=2)
    assert p.probe("/a") == "unreadable"
    t0 = time.monotonic()
    assert p.probe("/a") == "unreadable"
    assert time.monotonic() - t0 < 0.1


def test_thread_start_failure_frees_the_slot(monkeypatch):
    p = OpenProber(opener=lambda path: None, timeout=0.2, cap=1)

    def boom(self):
        raise RuntimeError("can't start new thread")
    with monkeypatch.context() as m:
        m.setattr(threading.Thread, "start", boom)
        assert p.probe("/a") == "unreadable"
    assert p.probe("/a") == "ok"


def test_base_exception_from_opener_is_unreadable():
    def boom(path):
        raise KeyboardInterrupt
    assert OpenProber(opener=boom, timeout=1, cap=1).probe("/a") == "unreadable"
