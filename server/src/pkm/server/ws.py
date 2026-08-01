# pattern: Imperative Shell
"""WebSocket hub: committed op batches broadcast to every open client.

broadcast() hands each frame to a small per-client queue and returns --
it never waits on a client's network send. A dedicated "drain" task per
connection is the sole consumer of that client's queue, so frames are
delivered strictly in the order broadcast() was called for that client,
even though delivery to different clients proceeds fully concurrently
(pkm-nn57; the previous implementation awaited each client in turn with a
one-second timeout, so N stalled clients added N seconds of latency to
every write that broadcasts).

A client that fails to keep its queue draining (QUEUE_SIZE behind) or
whose send doesn't complete within SEND_TIMEOUT is disconnected outright
rather than buffered or waited on further -- proportionate for this
single-user server's handful of replicas. It reconnects and resyncs from
its cursor, which is the correctness mechanism regardless of nudge
delivery (see notify.py). There is no separate cap on total connection
count: the queue bound and per-send timeout already bound the cost of any
one broadcast() call and of any one client, which is what actually
matters at this scale.
"""
from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from pkm.server.auth import COOKIE_NAME
from pkm.server.auth_core import verify_session

router = APIRouter()

SEND_TIMEOUT = 1.0  # a stalled client is dropped, not waited on
QUEUE_SIZE = 8  # a client this far behind is dropped, not buffered forever


class _Client:
    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=QUEUE_SIZE)
        self.drain_task: asyncio.Task[None] | None = None


class Hub:
    def __init__(self) -> None:
        self._clients: dict[WebSocket, _Client] = {}

    @property
    def _conns(self) -> set[WebSocket]:
        """Connected sockets. Named to match the pre-pkm-nn57 attribute
        so existing call sites/tests reading connection membership don't
        need to know about the per-client queue internals."""
        return set(self._clients)

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        client = _Client(ws)
        client.drain_task = asyncio.create_task(self._drain(client))
        self._clients[ws] = client

    def disconnect(self, ws: WebSocket) -> None:
        client = self._clients.pop(ws, None)
        if client is not None and client.drain_task is not None:
            client.drain_task.cancel()

    async def broadcast(self, message: dict) -> None:
        for client in list(self._clients.values()):
            try:
                client.queue.put_nowait(message)
            except asyncio.QueueFull:
                self.disconnect(client.ws)

    async def _drain(self, client: _Client) -> None:
        """Sends one client's queued frames strictly in order, for the
        lifetime of the connection. Runs as its own task so a slow or
        stalled client never blocks broadcast() or any other client."""
        try:
            while True:
                message = await client.queue.get()
                try:
                    await asyncio.wait_for(client.ws.send_json(message),
                                           timeout=SEND_TIMEOUT)
                except Exception:
                    self.disconnect(client.ws)
                    return
        except asyncio.CancelledError:
            pass


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
