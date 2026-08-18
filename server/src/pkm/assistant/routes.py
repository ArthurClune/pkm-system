# pattern: Imperative Shell
"""HTTP/SSE endpoints for the embedded assistant."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from pkm.assistant.events import SSE_COMMENT, AssistantEvent, ErrorEvent, encode_sse
from pkm.assistant.service import (
    AssistantService,
    BusyError,
    ConversationLimitError,
    UnknownConversationError,
)
from pkm.assistant.policy import DEFAULT_MODEL
from pkm.contracts.responses import AssistantAck, AssistantConversation, AssistantModels
from pkm.server.auth import require_auth

logger = logging.getLogger("pkm.assistant")

router = APIRouter(dependencies=[Depends(require_auth)])

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}

# pkm-mbcc defect 1: a turn is genuinely silent for long stretches -- the model
# reasoning about a large block, serialising a big tool call, or a confirm
# parked on the user's decision -- and an idle connection is exactly what
# mobile backgrounding and NAT/proxy idle timeouts drop. The frames below both
# keep the connection warm and force a periodic write, so a peer that has
# silently gone away surfaces here (and the turn is then cleaned up) instead of
# only when the next real event is written into a dead socket.
KEEPALIVE_INTERVAL_S = 15.0


async def _abandon_stream(
    stream: AsyncGenerator[AssistantEvent, None], pending: asyncio.Task[AssistantEvent] | None
) -> None:
    """Cancel the in-flight read, then close `stream`, on the way out.

    Closing it here rather than letting it be collected is the point: the
    engine's abandon-turn protocol (decline parked confirms, bounded
    interrupt, retire the harness -- `ClaudeConversation._abandon_turn`) lives
    in that generator's `finally`, and an orphaned async generator runs its
    `finally` when CPython's finalizer hook gets to it, which is prompt in
    practice but not a schedule. pkm-f3mo.

    Two orderings carry weight:

    - Cancel the pending `anext` *and await it* before closing. `cancel()`
      only requests cancellation, and `aclose()` on a generator with an
      `__anext__` still in flight raises "asynchronous generator is already
      running" -- which would abandon teardown at its first step.
    - Report, never raise. This runs while a `GeneratorExit` or a
      cancellation is already unwinding the consumer; anything raised from
      here would replace that disconnect with an unrelated error and skip
      the rest of the teardown. The enclosing task is being torn down
      anyway, so a cancellation landing in here is logged rather than
      re-raised.
    """
    if pending is not None:
        pending.cancel()
        with contextlib.suppress(Exception, asyncio.CancelledError):
            # exhausted, an engine error nobody will read now, or the
            # cancellation just requested -- all equally uninteresting
            await pending
    try:
        await stream.aclose()
    except asyncio.CancelledError:
        logger.warning("assistant stream close cancelled during SSE teardown")
    except Exception:
        logger.exception("assistant stream close failed during SSE teardown")


async def _with_keepalive(
    stream: AsyncGenerator[AssistantEvent, None], interval: float
) -> AsyncGenerator[str, None]:
    """Encode `stream`, emitting a comment frame every `interval` idle seconds."""
    pending: asyncio.Task[AssistantEvent] | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(anext(stream))
            # asyncio.wait (unlike wait_for) leaves the task running on
            # timeout, so the in-flight anext survives every keepalive.
            done, _ = await asyncio.wait({pending}, timeout=interval)
            if not done:
                yield SSE_COMMENT
                continue
            settled, pending = pending, None
            try:
                event = settled.result()
            except StopAsyncIteration:
                return
            yield encode_sse(event)
    finally:
        await _abandon_stream(stream, pending)


async def _sse_frames(
    stream: AsyncGenerator[AssistantEvent, None], interval: float
) -> AsyncGenerator[str, None]:
    """The response body for one turn: keepalive-interleaved SSE frames.

    `aclosing`, not a bare `async for`: Starlette closes (or cancels) this
    generator when the client disconnects, and only an explicit close passes
    that on to the keepalive wrapper's teardown -- see `_abandon_stream`.
    """
    async with contextlib.aclosing(_with_keepalive(stream, interval)) as frames:
        try:
            async for frame in frames:
                yield frame
        except Exception as exc:  # engine failure mid-stream: report in-band
            yield encode_sse(ErrorEvent(message=str(exc)))


class CreateConversationRequest(BaseModel):
    model: str | None = None


class SendMessageRequest(BaseModel):
    text: str


class ConfirmRequestBody(BaseModel):
    tool_use_id: str
    allow: bool


def get_service(request: Request) -> AssistantService:
    service = request.app.state.assistant
    if service is None:
        raise HTTPException(status_code=503, detail="assistant not configured")
    return service


@router.get("/api/assistant/models", response_model=AssistantModels)
def list_models(service: AssistantService = Depends(get_service)) -> dict:
    """Models the picker may offer; glm appears only when a z.ai key is
    configured, so the UI can hide rather than error on it."""
    return {"models": service.available_models, "default": DEFAULT_MODEL}


@router.post("/api/assistant/conversations", response_model=AssistantConversation)
async def create_conversation(
    body: CreateConversationRequest, service: AssistantService = Depends(get_service)
) -> dict:
    try:
        cid, model = await service.create(body.model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ConversationLimitError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"id": cid, "model": model}


@router.post("/api/assistant/conversations/{conversation_id}/messages")
async def send_message(
    conversation_id: str,
    body: SendMessageRequest,
    service: AssistantService = Depends(get_service),
) -> StreamingResponse:
    try:
        stream = service.send(conversation_id, body.text)
    except UnknownConversationError as exc:
        raise HTTPException(status_code=404, detail="unknown conversation") from exc
    except BusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return StreamingResponse(
        _sse_frames(stream, KEEPALIVE_INTERVAL_S),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@router.post("/api/assistant/conversations/{conversation_id}/confirm", response_model=AssistantAck)
async def confirm_tool(
    conversation_id: str,
    body: ConfirmRequestBody,
    service: AssistantService = Depends(get_service),
) -> dict:
    try:
        service.confirm(conversation_id, body.tool_use_id, body.allow)
    except UnknownConversationError as exc:
        raise HTTPException(status_code=404, detail="unknown conversation") from exc
    return {"ok": True}


async def delete_conversation(
    conversation_id: str, service: AssistantService = Depends(get_service)
) -> dict:
    await service.delete(conversation_id)
    return {"ok": True}


# Registered under both DELETE (the RESTful shape) and POST (because
# navigator.sendBeacon -- used by the web client on pagehide to clean up a
# conversation the user is navigating away from -- can only send POST, with
# no custom headers/body control). Two explicit registrations, each with
# its own operation_id, avoid FastAPI's duplicate-operation-id warning that
# a single multi-method route would otherwise emit.
router.add_api_route(
    "/api/assistant/conversations/{conversation_id}",
    delete_conversation,
    methods=["DELETE"],
    response_model=AssistantAck,
    operation_id="delete_conversation",
)
router.add_api_route(
    "/api/assistant/conversations/{conversation_id}",
    delete_conversation,
    methods=["POST"],
    response_model=AssistantAck,
    operation_id="close_conversation_beacon",
)
