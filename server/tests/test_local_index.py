import threading
import time
from pathlib import Path

from pkm.server.local_index import TreeScanner


def test_concurrent_callers_share_one_walk(tmp_path):
    gate = threading.Event()
    started = threading.Event()
    calls = []

    def walker(root):
        calls.append(root)
        started.set()
        gate.wait(10)
        return ["a.pdf"]

    scanner = TreeScanner(walker=walker, timeout=5)
    results = []
    threads = [threading.Thread(target=lambda: results.append(scanner.scan(tmp_path)))
               for _ in range(2)]
    threads[0].start()
    assert started.wait(5)
    threads[1].start()
    time.sleep(0.1)
    gate.set()
    for t in threads:
        t.join(5)
    assert results == [["a.pdf"], ["a.pdf"]]
    assert len(calls) == 1


def test_blocked_walk_times_out_and_a_later_call_rejoins_it(tmp_path):
    gate = threading.Event()
    calls = []

    def walker(root):
        calls.append(root)
        gate.wait(10)
        return []

    scanner = TreeScanner(walker=walker, timeout=0.1)
    try:
        assert scanner.scan(tmp_path) is None
        began = time.monotonic()
        assert scanner.scan(tmp_path) is None
        assert time.monotonic() - began < 0.05
        assert len(calls) == 1
    finally:
        gate.set()


def test_a_finished_walk_frees_the_scanner_for_the_next_call(tmp_path):
    scanner = TreeScanner(walker=lambda root: ["a.pdf"], timeout=1)
    assert scanner.scan(tmp_path) == ["a.pdf"]
    assert scanner.scan(tmp_path) == ["a.pdf"]


def test_walker_oserror_is_none(tmp_path):
    def walker(root):
        raise PermissionError("no")

    assert TreeScanner(walker=walker, timeout=1).scan(tmp_path) is None


def test_missing_or_non_directory_root_is_none(tmp_path):
    f = tmp_path / "file"
    f.write_text("x")
    scanner = TreeScanner(timeout=1)
    assert scanner.scan(tmp_path / "nope") is None
    assert scanner.scan(f) is None


def test_default_walker_lists_a_tree(tmp_path):
    (tmp_path / "d").mkdir()
    (tmp_path / "d" / "b.pdf").write_bytes(b"x")
    (tmp_path / "A.pdf").write_bytes(b"x")
    assert TreeScanner(timeout=1).scan(Path(tmp_path)) == ["A.pdf", "d/b.pdf"]
