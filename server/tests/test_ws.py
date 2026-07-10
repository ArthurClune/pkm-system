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
            "ops": [{"op": "set_collapsed", "uid": "uid_b2",
                     "collapsed": True}]})
        assert r.status_code == 200
        msg = ws.receive_json()
        assert msg["client_id"] == "sender-1"
        assert msg["ts"] == r.json()["ts"]
        assert msg["ops"] == [{"op": "set_collapsed", "uid": "uid_b2",
                               "collapsed": True}]


def test_failed_batch_broadcasts_nothing(client):
    with client.websocket_connect("/api/ws") as ws:
        r = client.post("/api/ops", json={
            "client_id": "sender-1",
            "ops": [{"op": "delete", "uid": "ghost99"}]})
        assert r.status_code == 400
        ok = client.post("/api/ops", json={
            "client_id": "sender-2",
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
