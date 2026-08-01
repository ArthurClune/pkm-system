import asyncio
import json
from typing import Any

import httpx2
import pytest

from pkm.describe.openai_client import OpenAIDescriber
from pkm.describe.service import DescribeError


def _describe(handler, content=b"\x89PNGdata", mime="image/png") -> str:
    async def run() -> str:
        http = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
        client = OpenAIDescriber("sk-test", "gpt-4o-mini", http=http)
        try:
            return await client.describe(content, mime)
        finally:
            await client.close()

    return asyncio.run(run())


def test_describe_success():
    seen: dict[str, Any] = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = json.loads(request.content)
        return httpx2.Response(200, json={
            "choices": [{"message": {"content": "a scatter plot of latency"}}]})

    assert _describe(handler) == "a scatter plot of latency"
    assert seen["auth"] == "Bearer sk-test"
    assert seen["body"]["model"] == "gpt-4o-mini"
    url = seen["body"]["messages"][0]["content"][1]["image_url"]["url"]
    assert url.startswith("data:image/png;base64,")


def test_describe_http_error():
    def handler(request):
        return httpx2.Response(429, json={"error": {"message": "rate limited"}})

    with pytest.raises(DescribeError, match="openai http 429"):
        _describe(handler)


def test_describe_network_error():
    def handler(request):
        raise httpx2.ConnectTimeout("timed out")

    with pytest.raises(DescribeError, match="network error"):
        _describe(handler)


def test_describe_malformed_body():
    def handler(request):
        return httpx2.Response(200, json={"choices": []})

    with pytest.raises(DescribeError, match="bad response"):
        _describe(handler)


def test_describe_non_json_body():
    def handler(request):
        return httpx2.Response(200, text="<html>gateway error</html>")

    with pytest.raises(DescribeError, match="bad response"):
        _describe(handler)


def test_close_closes_injected_http_client():
    async def run() -> bool:
        http = httpx2.AsyncClient()
        client = OpenAIDescriber("sk-test", "gpt-4o-mini", http=http)
        await client.close()
        return http.is_closed

    assert asyncio.run(run()) is True
