"""ClaudeSDKClient doubles, shared by the engine and SSE-teardown tests.

receive_response() awaits a queue, like the real SDK awaits the CLI
subprocess, so a turn stays live while a confirm round-trip is pending: a
double that resolves immediately never exercises the dropped-consumer
cleanup path at all (pkm-mbcc).
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from claude_agent_sdk import ResultMessage

from pkm.assistant.claude_engine import ClaudeEngine

SECRET = "ab" * 32


def make_result(**over) -> ResultMessage:
    defaults = dict(
        subtype="success", duration_ms=1, duration_api_ms=1, is_error=False,
        num_turns=1, session_id="s1", usage={"input_tokens": 5},
    )
    defaults.update(over)
    return ResultMessage(**defaults)


class FakeSDKClient:
    """Stands in for ClaudeSDKClient; instances are created by client_factory.

    Feed messages with feed(); a ResultMessage ends the turn.
    """

    instances: list["FakeSDKClient"] = []

    def __init__(self, options):
        self.options = options
        self.connected = False
        self.queries: list[str] = []
        self.interrupts = 0
        self.disconnect_calls = 0
        self.messages: asyncio.Queue = asyncio.Queue()
        FakeSDKClient.instances.append(self)

    def feed(self, *msgs):
        for msg in msgs:
            self.messages.put_nowait(msg)

    async def connect(self):
        self.connected = True

    async def disconnect(self):
        self.connected = False
        self.disconnect_calls += 1

    async def query(self, text):
        self.queries.append(text)

    async def interrupt(self):
        self.interrupts += 1

    async def receive_response(self):
        while True:
            msg = await self.messages.get()
            yield msg
            if isinstance(msg, ResultMessage):
                return


class HangingInterruptClient(FakeSDKClient):
    """interrupt() never returns.

    That is what the real harness does when it is parked inside can_use_tool:
    it cannot acknowledge an interrupt until the permission decision it is
    awaiting arrives (pkm-mbcc defect 2). FakeSDKClient's instant interrupt()
    hides the ordering bug entirely.
    """

    async def interrupt(self):
        self.interrupts += 1
        await asyncio.Event().wait()  # never set


def make_engine(tmp_path: Path, factory=FakeSDKClient, zai_token=None) -> ClaudeEngine:
    FakeSDKClient.instances.clear()
    return ClaudeEngine(
        base_url="http://127.0.0.1:8999",
        session_secret_hex=SECRET,
        client_factory=factory,
        config_dir=tmp_path,
        zai_token=zai_token,
    )
