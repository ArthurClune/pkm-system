# pattern: Imperative Shell
"""OpenAI-backed ImageDescriber: one HTTPS POST per image (pkm-zc0c).
Plain httpx2 against the chat-completions endpoint — no OpenAI SDK."""
from __future__ import annotations

import base64

import httpx2

from pkm.describe.core import parse_description, request_payload
from pkm.describe.service import DescribeError

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
_TIMEOUT_SECONDS = 60.0


class OpenAIDescriber:
    def __init__(self, api_key: str, model: str,
                 http: httpx2.AsyncClient | None = None):
        self._model = model
        self._http = http if http is not None else httpx2.AsyncClient(
            timeout=_TIMEOUT_SECONDS)
        self._headers = {"Authorization": f"Bearer {api_key}"}

    async def describe(self, image_bytes: bytes, mime: str) -> str:
        b64 = base64.b64encode(image_bytes).decode("ascii")
        payload = request_payload(self._model, mime, b64)
        try:
            r = await self._http.post(OPENAI_URL, json=payload,
                                      headers=self._headers)
        except httpx2.TransportError as e:
            raise DescribeError(f"network error: {type(e).__name__}")
        if r.status_code >= 400:
            raise DescribeError(f"openai http {r.status_code}")
        try:
            return parse_description(r.json())
        except ValueError as e:
            raise DescribeError(f"bad response: {e}")

    async def close(self) -> None:
        await self._http.aclose()
