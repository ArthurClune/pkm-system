import asyncio
from typing import cast

import pytest
from starlette.websockets import WebSocket, WebSocketDisconnect


class _GoodWS:
    def __init__(self):
        self.sent = []

    async def send_json(self, message):
        self.sent.append(message)


class _RaisingWS:
    async def send_json(self, message):
        raise RuntimeError("client gone")


class _StallingWS:
    async def send_json(self, message):
        await asyncio.sleep(60)


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
    hub = ws_module.Hub()
    good, raising, stalling = _GoodWS(), _RaisingWS(), _StallingWS()
    for conn in (raising, stalling, good):
        hub._conns.add(cast(WebSocket, conn))
    asyncio.run(hub.broadcast({"ok": 1}))
    assert good.sent == [{"ok": 1}]
    assert hub._conns == {good}


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
    with client.websocket_connect("/api/ws") as ws:
        r = client.get("/api/page/July%2013th,%202026")
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
