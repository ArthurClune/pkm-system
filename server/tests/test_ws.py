import pytest
from starlette.websockets import WebSocketDisconnect


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
