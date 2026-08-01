import asyncio
import time
from typing import cast

import pytest
from starlette.websockets import WebSocket, WebSocketDisconnect


class _GoodWS:
    def __init__(self):
        self.sent = []
        self.closed = False

    async def accept(self):
        pass

    async def send_json(self, message):
        self.sent.append(message)

    async def close(self):
        self.closed = True


class _RaisingWS:
    def __init__(self):
        self.closed = False

    async def accept(self):
        pass

    async def send_json(self, message):
        raise RuntimeError("client gone")

    async def close(self):
        self.closed = True


class _StallingWS:
    def __init__(self):
        self.closed = False

    async def accept(self):
        pass

    async def send_json(self, message):
        await asyncio.sleep(60)

    async def close(self):
        self.closed = True


class _SlowThenFastWS:
    """Its first send is slow; later sends are instant. Used to prove a
    later broadcast() can't jump ahead of an earlier one still in flight
    to the same client."""

    def __init__(self, first_delay: float):
        self.sent = []
        self._first_delay = first_delay

    async def accept(self):
        pass

    async def send_json(self, message):
        if self._first_delay:
            delay, self._first_delay = self._first_delay, 0
            await asyncio.sleep(delay)
        self.sent.append(message)


async def _until(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def test_ws_requires_auth(anon_client):
    with pytest.raises(WebSocketDisconnect) as exc:
        with anon_client.websocket_connect("/api/ws") as ws:
            ws.receive_text()
    assert exc.value.code == 4401


def test_ops_broadcast_to_connected_clients(client):
    with client.websocket_connect("/api/ws") as ws:
        r = client.post("/api/ops", json={
            "client_id": "sender-1",
            "batch_id": "ws_broadcast1",
            "ops": [{"op": "set_collapsed", "uid": "uid_b2",
                     "collapsed": True}]})
        assert r.status_code == 200
        msg = ws.receive_json()
        assert msg["client_id"] == "sender-1"
        assert msg["ts"] == r.json()["ts"]
        assert msg["ops"] == [{"op": "set_collapsed", "uid": "uid_b2",
                               "collapsed": True}]


def test_cross_page_move_broadcast_carries_resolved_page_title(client):
    # A parent-based cross-page move sent WITHOUT page_title (legal: the
    # server resolves the target page from the parent). Remote clients can't
    # act on a bare move — the source can't drop the block (parent isn't in
    # its tree) and the target's refetch keys on page_title — so the broadcast
    # is enriched with the resolved target title even though the request omits
    # it. uid_b4 lives on "July 7th, 2026"; uid_b2 lives on "Machine Learning".
    with client.websocket_connect("/api/ws") as ws:
        r = client.post("/api/ops", json={
            "client_id": "sender-1",
            "batch_id": "ws_move_title1",
            "ops": [{"op": "move", "uid": "uid_b4", "parent_uid": "uid_b2",
                     "order_idx": 99}]})
        assert r.status_code == 200
        assert ws.receive_json()["ops"] == [
            {"op": "move", "uid": "uid_b4", "parent_uid": "uid_b2",
             "order_idx": 99, "page_title": "Machine Learning"}]


def test_same_page_move_broadcast_keeps_page_title_null(client):
    # A same-page move stays page_title: null — enrichment only fires when the
    # resolved target page differs from the block's current page.
    with client.websocket_connect("/api/ws") as ws:
        r = client.post("/api/ops", json={
            "client_id": "sender-1",
            "batch_id": "ws_same_page1",
            "ops": [{"op": "move", "uid": "uid_b3", "parent_uid": None,
                     "order_idx": 0}]})
        assert r.status_code == 200
        assert ws.receive_json()["ops"] == [
            {"op": "move", "uid": "uid_b3", "parent_uid": None,
             "order_idx": 0, "page_title": None}]


def test_failed_batch_broadcasts_nothing(client):
    with client.websocket_connect("/api/ws") as ws:
        r = client.post("/api/ops", json={
            "client_id": "sender-1",
            "batch_id": "ws_failed1",
            "ops": [{"op": "delete", "uid": "ghost99"}]})
        assert r.status_code == 400
        ok = client.post("/api/ops", json={
            "client_id": "sender-2",
            "batch_id": "ws_ok_batch1",
            "ops": [{"op": "set_collapsed", "uid": "uid_b1",
                     "collapsed": True}]})
        assert ok.status_code == 200
        # first message received is the SECOND (successful) batch
        assert ws.receive_json()["client_id"] == "sender-2"


def test_broadcast_drops_bad_connections_and_still_delivers(monkeypatch):
    from pkm.server import ws as ws_module
    monkeypatch.setattr(ws_module, "SEND_TIMEOUT", 0.05)

    async def _run():
        hub = ws_module.Hub()
        good, raising, stalling = _GoodWS(), _RaisingWS(), _StallingWS()
        for conn in (raising, stalling, good):
            await hub.connect(cast(WebSocket, conn))
        await hub.broadcast({"ok": 1})
        # delivery now happens on each client's own drain task, not
        # synchronously inside broadcast() -- wait for it to land.
        await _until(lambda: good.sent == [{"ok": 1}])
        await _until(lambda: set(hub._conns) == {good})
        # Hub-initiated drops (send failure/timeout) must close the
        # socket, or a real client would never see `onclose` fire and
        # reconnect (pkm-nn57 final review).
        await _until(lambda: raising.closed and stalling.closed)
        assert good.sent == [{"ok": 1}]
        assert set(hub._conns) == {good}
        assert raising.closed
        assert stalling.closed
        assert not good.closed

    asyncio.run(_run())


def test_broadcast_does_not_block_on_stalled_clients(monkeypatch):
    """pkm-nn57: the old Hub.broadcast() awaited each client sequentially
    with a SEND_TIMEOUT-bounded wait, so N stalled clients added
    N * SEND_TIMEOUT of latency to every write that broadcasts. It must
    now hand frames off (e.g. to a per-client queue) and return without
    waiting on any client's send, so the cost is independent of how many
    clients are stalled."""
    from pkm.server import ws as ws_module
    monkeypatch.setattr(ws_module, "SEND_TIMEOUT", 0.2)

    async def _run():
        hub = ws_module.Hub()
        stalling = [_StallingWS() for _ in range(10)]
        for conn in stalling:
            await hub.connect(cast(WebSocket, conn))
        start = time.monotonic()
        await hub.broadcast({"ok": 1})
        elapsed = time.monotonic() - start
        # sequentially-with-timeout would cost 10 * 0.2s = 2s; a
        # non-blocking hand-off should return in well under one timeout.
        assert elapsed < 0.2, (
            f"broadcast() blocked for {elapsed:.3f}s on stalled clients")

    asyncio.run(_run())


def test_broadcast_preserves_per_client_order_when_first_send_is_slow():
    """A client's still-in-flight first frame must not let a later
    broadcast() call's frame arrive first -- clients must never observe
    seq nudges out of order (pkm-nn57)."""
    from pkm.server import ws as ws_module

    async def _run():
        hub = ws_module.Hub()
        client = _SlowThenFastWS(first_delay=0.1)
        await hub.connect(cast(WebSocket, client))
        # fired concurrently, not awaited one after another, so a naive
        # unordered concurrent fan-out could let seq 2 win the race
        await asyncio.gather(hub.broadcast({"seq": 1}),
                             hub.broadcast({"seq": 2}))
        await _until(lambda: len(client.sent) == 2)
        assert client.sent == [{"seq": 1}, {"seq": 2}]

    asyncio.run(_run())


def test_broadcast_disconnects_client_whose_queue_overflows(monkeypatch):
    """A client that isn't draining fast enough (queue full) is dropped
    outright rather than buffered without bound -- and its socket is
    actually closed, so a real client sees `onclose` fire and reconnects
    and resyncs from its cursor, same as any other dropped connection
    (pkm-nn57 final review: a Hub-initiated drop that never closes the
    socket leaves a healthy-but-slow client wedged until tab reload)."""
    from pkm.server import ws as ws_module
    monkeypatch.setattr(ws_module, "QUEUE_SIZE", 2)

    async def _run():
        hub = ws_module.Hub()
        client = _StallingWS()
        await hub.connect(cast(WebSocket, client))
        # No awaits occur between these calls, so the client's drain
        # task never gets a turn to dequeue -- the queue genuinely fills.
        for i in range(5):
            await hub.broadcast({"seq": i})
        assert cast(WebSocket, client) not in hub._conns
        # The close is fired via asyncio.create_task (broadcast()'s
        # enqueue loop can't await it), so give it a turn to run.
        await _until(lambda: client.closed)
        assert client.closed

    asyncio.run(_run())


def test_safe_close_swallows_close_errors():
    """_safe_close is used for Hub-initiated drops on connections that
    may already be half-closed; a raising close() must not propagate --
    it's sometimes awaited as a fire-and-forget task, where an unhandled
    exception would surface as "Task exception was never retrieved"."""
    from pkm.server.ws import _safe_close

    class _AlreadyClosedWS:
        async def close(self):
            raise RuntimeError("already closed")

    asyncio.run(_safe_close(cast(WebSocket, _AlreadyClosedWS())))  # no raise


def _frames_until_seq(ws, tries=5):
    frames = []
    for _ in range(tries):
        frames.append(ws.receive_json())
        if frames[-1].get("type") == "seq":
            return frames
    raise AssertionError(f"no seq nudge in {frames}")


def test_ops_commit_emits_seq_nudge_after_batch_frame(client):
    with client.websocket_connect("/api/ws") as ws:
        r = client.post("/api/ops", json={
            "client_id": "n1",
            "batch_id": "ws_seq_nudge1",
            "ops": [{"op": "update_text", "uid": "uid_b1", "text": "x"}]})
        assert r.status_code == 200
        frames = _frames_until_seq(ws)
        assert frames[-1]["seq"] > 0


def test_non_op_write_paths_emit_seq_nudge(client):
    # sidebar write and page create commit outside /api/ops -- the exact
    # paths the spec calls out as silent today
    with client.websocket_connect("/api/ws") as ws:
        assert client.post("/api/sidebar",
                           json={"title": "AI"}).status_code == 200
        assert _frames_until_seq(ws)[-1]["type"] == "seq"
    with client.websocket_connect("/api/ws") as ws:
        assert client.post("/api/pages",
                           json={"title": "Nudge Page"}).status_code == 200
        assert _frames_until_seq(ws)[-1]["type"] == "seq"


def test_daily_autocreate_on_get_emits_seq_nudge(client):
    from datetime import date
    from pkm.server.daily import title_for_date

    with client.websocket_connect("/api/ws") as ws:
        today = title_for_date(date.today())
        r = client.get(f"/api/page/{today}")
        assert r.status_code == 200
        assert _frames_until_seq(ws)[-1]["type"] == "seq"


def test_seq_frame_is_typed_and_validated():
    """pkm-x7a5: the WS nudge frame is built from a typed model, not an
    ad-hoc dict literal (spec contract-hardening)."""
    import sqlite3

    from pkm.schema import DDL
    from pkm.server.notify import SeqFrame, seq_frame

    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript(DDL)
    frame = seq_frame(con)
    assert frame == {"type": "seq", "seq": 0}
    assert SeqFrame(**frame).seq == 0
    con.close()
