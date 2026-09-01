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
rather than buffered or waited on further. Those two thresholds are
deliberately patient -- tuned for a flaky link, not a LAN (pkm-d6i6).
Since sends moved into per-client drain tasks, a slow client costs this
single-user server only its queued nudges (bytes) and one lingering
drain task, while every drop costs the client a full reconnect, changes
pull and resyncSeq refetch. Patience is the proportionate policy here;
the bounds exist so a zombie connection is still finite, not to keep
delivery prompt. Disconnecting also closes the
socket (`_safe_close`): the connection may still be alive at the
transport level even though the Hub has given up on it, and closing is
what makes the web client's `onclose` handler fire so it actually
reconnects and resyncs from its cursor, which is the correctness
mechanism regardless of nudge delivery (see notify.py). There is no
separate cap on total connection count: the queue bound and per-send
timeout already bound the cost of any one broadcast() call and of any
one client, which is what actually matters at this scale.
"""
from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from pkm.server.auth import COOKIE_NAME
from pkm.server.auth_core import verify_session

router = APIRouter()

SEND_TIMEOUT = 10.0  # only a wedged client is dropped; a slow one is waited on
QUEUE_SIZE = 64  # a client this far behind is dropped, not buffered forever
CLOSE_TIMEOUT = 2.0  # generous: best-effort, and only ever delays a drop


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

    def _forget(self, ws: WebSocket) -> _Client | None:
        """Remove ws from the registry only -- no cancellation. Once
        popped, no concurrent broadcast() can see this client any more
        (its loop iterates a snapshot of self._clients), which is what
        makes it safe to close the socket afterwards without racing a
        broadcast() that might otherwise try to drop the same client
        mid-close (pkm-nn57 third-round review)."""
        return self._clients.pop(ws, None)

    def disconnect(self, ws: WebSocket) -> None:
        """For external callers only -- ws_endpoint's finally block and
        broadcast()'s QueueFull branch, both of which are cancelling a
        DIFFERENT task than the one currently running. _drain's own
        except branch must NOT call this (see its comment): it forgets
        the client itself and returns without ever cancelling its own
        task."""
        client = self._forget(ws)
        if client is not None and client.drain_task is not None:
            client.drain_task.cancel()

    async def broadcast(self, message: dict) -> None:
        # No await in this loop -- required so two overlapping
        # broadcast() calls always enqueue in call order for a given
        # client, which is what gives per-client FIFO ordering without a
        # lock (pkm-nn57).
        for client in list(self._clients.values()):
            try:
                client.queue.put_nowait(message)
            except asyncio.QueueFull:
                self.disconnect(client.ws)
                # Fire-and-forget: a Hub-initiated drop must actually
                # close the socket, or the client never sees `onclose`
                # and won't reconnect (pkm-nn57 final review) -- but
                # this loop can't await it without breaking the FIFO
                # ordering guarantee above. This is always a different
                # task from client.drain_task (that task, if it's mid
                # send, is off doing its own thing; if it's mid-close,
                # _forget already removed the client above so this
                # except branch can no longer even be reached for it --
                # see _drain).
                asyncio.create_task(_safe_close(client.ws))

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
                    # Forget (registry-only) BEFORE closing, and never
                    # call self.disconnect() here: this coroutine IS the
                    # drain task, so self.disconnect() would cancel
                    # itself, and a pending self-cancel interrupts
                    # whatever this coroutine awaits next -- landing
                    # inside WebSocket.close()'s own internal await and
                    # cutting it short (pkm-nn57 second-round review).
                    # Forgetting first ALSO closes a second, cross-task
                    # version of the same race: while the close below is
                    # in flight, this client is still technically
                    # registered unless removed now, so a concurrent
                    # broadcast() could hit QueueFull for it and call
                    # disconnect() -> cancel() on this very task from
                    # the outside, non-deterministically reproducing the
                    # identical cut-short-close bug (pkm-nn57
                    # third-round review). Once forgotten, no broadcast()
                    # can see this client to drop it, so this task's own
                    # eventual return is the only thing that can end it.
                    self._forget(client.ws)
                    await _safe_close(client.ws)
                    return
        except asyncio.CancelledError:
            pass


async def _safe_close(ws: WebSocket) -> None:
    """Best-effort, timeout-bounded close for a Hub-initiated drop.
    Errors (including a CLOSE_TIMEOUT-triggered TimeoutError) are
    expected and swallowed -- the socket may already be half-closed, or
    its transport wedged, and this is sometimes awaited as a
    fire-and-forget task, where an unhandled exception would otherwise
    surface as "Task exception was never retrieved". A wedged transport
    must not hang the caller (broadcast()'s overflow path doesn't await
    this at all; _drain's does, and would otherwise never return)."""
    try:
        await asyncio.wait_for(ws.close(), timeout=CLOSE_TIMEOUT)
    except Exception:
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
