# pattern: Imperative Shell
"""HTTP/SSE endpoints for the embedded assistant."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator

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


async def _with_keepalive(
    stream: AsyncIterator[AssistantEvent], interval: float
) -> AsyncGenerator[str, None]:
    """Encode `stream`, emitting a comment frame every `interval` idle seconds."""
    iterator = stream.__aiter__()
    pending: asyncio.Task[AssistantEvent] | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(anext(iterator))
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
        if pending is not None:
            pending.cancel()


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

    async def sse() -> AsyncIterator[str]:
        try:
            async for frame in _with_keepalive(stream, KEEPALIVE_INTERVAL_S):
                yield frame
        except Exception as exc:  # engine failure mid-stream: report in-band
            yield encode_sse(ErrorEvent(message=str(exc)))

    return StreamingResponse(sse(), media_type="text/event-stream", headers=SSE_HEADERS)


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
