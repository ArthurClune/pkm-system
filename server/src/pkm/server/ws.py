# pattern: Imperative Shell
"""WebSocket hub: committed op batches broadcast to every open client."""
from __future__ import annotations

import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from pkm.server.auth import COOKIE_NAME
from pkm.server.auth_core import verify_session

router = APIRouter()


class Hub:
    def __init__(self) -> None:
        self._conns: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._conns.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._conns.discard(ws)

    async def broadcast(self, message: dict) -> None:
        for ws in list(self._conns):
            try:
                await ws.send_json(message)
            except Exception:
                self._conns.discard(ws)


@router.websocket("/api/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    config = websocket.app.state.config
    token = websocket.cookies.get(COOKIE_NAME)
    if not token or not verify_session(
            bytes.fromhex(config.session_secret), token,
            now_ms=int(time.time() * 1000)):
        await websocket.close(code=4401)
        return
    hub: Hub = websocket.app.state.hub
    await hub.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # inbound is ignored (keepalive)
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(websocket)
