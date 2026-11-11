import time

from pkm.server.clock import now_ms


def test_now_ms_reads_the_wall_clock_in_milliseconds():
    before = int(time.time() * 1000)
    reading = now_ms()
    after = int(time.time() * 1000)
    assert before <= reading <= after
