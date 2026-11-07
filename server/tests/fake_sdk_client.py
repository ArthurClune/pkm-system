"""ClaudeSDKClient doubles, shared by the engine and SSE-teardown tests.

receive_response() awaits a queue, like the real SDK awaits the CLI
subprocess, so a turn stays live while a confirm round-trip is pending: a
double that resolves immediately never exercises the dropped-consumer
cleanup path at all.
"""

from __future__ import annotations

import asyncio
from collections.abc import Collection, Sequence
from pathlib import Path
from typing import Literal

from claude_agent_sdk import CLIConnectionError, ResultMessage

from pkm.assistant.claude_engine import ClaudeEngine
from pkm.assistant.target_reader import BlockReader
from pkm.contracts.ops import BlockUid

SECRET = "ab" * 32


def make_result(**over) -> ResultMessage:
    defaults = dict(
        subtype="success", duration_ms=1, duration_api_ms=1, is_error=False,
        num_turns=1, session_id="s1", usage={"input_tokens": 5},
    )
    defaults.update(over)
    return ResultMessage(**defaults)


def aborted_result(**over) -> ResultMessage:
    """The ResultMessage the CLI writes for a turn an interrupt ended."""
    return make_result(**{"subtype": "error_during_execution", "is_error": True,
                          "terminal_reason": "aborted_streaming", **over})


# How long after acknowledging an interrupt the CLI writes the aborted
# result: 6 ms in a live run of the bundled CLI 2.1.301.
AFTER_ACK_S = 0.01

_END = object()


class _Died:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc


class FakeSDKClient:
    """Stands in for ClaudeSDKClient; instances are created by client_factory.

    Feed messages with feed(); a ResultMessage ends the turn. Like the SDK,
    every message is buffered until some receive_response() reads it, so a
    message nobody drained is the next turn's first.
    """

    instances: list["FakeSDKClient"] = []

    # What interrupt() does to an open turn. The bundled CLI acknowledges,
    # then writes the aborted turn's ResultMessage ("after_ack"); the others
    # are the orders a harness could also take. An interrupt with no turn
    # open is acknowledged with no result, as the CLI does.
    interrupt_result: Literal["after_ack", "before_ack", "never"] = "after_ack"

    def __init__(self, options):
        self.options = options
        self.connected = False
        self.queries: list[str] = []
        self.interrupts = 0
        self.disconnect_calls = 0
        self.messages: asyncio.Queue = asyncio.Queue()
        self.turn_open = False
        self.dead = False
        self._ended = False
        FakeSDKClient.instances.append(self)

    def feed(self, *msgs):
        for msg in msgs:
            if isinstance(msg, ResultMessage):
                self.turn_open = False
            self.messages.put_nowait(msg)

    def die(self, exc: Exception | None = None):
        """The subprocess exits: the stream raises, then ends for good."""
        self.dead = True
        self.turn_open = False
        self.messages.put_nowait(_Died(exc or CLIConnectionError("harness exited")))

    def end_stream(self):
        """The CLI's stdout closes cleanly with no ResultMessage."""
        self.dead = True
        self.turn_open = False
        self.messages.put_nowait(_END)

    async def connect(self):
        self.connected = True

    async def disconnect(self):
        self.connected = False
        self.disconnect_calls += 1

    async def query(self, text):
        if self.dead:
            raise CLIConnectionError("harness exited")
        self.queries.append(text)
        self.turn_open = True

    async def interrupt(self):
        self.interrupts += 1
        if self.dead:
            raise CLIConnectionError("harness exited")
        if not self.turn_open or self.interrupt_result == "never":
            return
        self.turn_open = False
        if self.interrupt_result == "before_ack":
            self.feed(aborted_result())
        else:
            asyncio.get_running_loop().call_later(
                AFTER_ACK_S, self.feed, aborted_result())

    async def receive_response(self):
        while not self._ended:
            msg = await self.messages.get()
            if msg is _END:
                self._ended = True
                return
            if isinstance(msg, _Died):
                self._ended = True
                raise msg.exc
            yield msg
            if isinstance(msg, ResultMessage):
                return


class HangingInterruptClient(FakeSDKClient):
    """interrupt() never returns.

    That is what the real harness does when it is parked inside can_use_tool:
    it cannot acknowledge an interrupt until the permission decision it is
    awaiting arrives. FakeSDKClient's instant interrupt() would hide that
    ordering bug entirely.
    """

    async def interrupt(self):
        self.interrupts += 1
        await asyncio.Event().wait()  # never set


def _no_rows(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
            ancestors_of: Collection[BlockUid]):
    """A reader for an engine with no database: no block has any uid."""
    return {}


def make_engine(tmp_path: Path, factory=FakeSDKClient, zai_token=None,
                read_blocks: BlockReader = _no_rows) -> ClaudeEngine:
    FakeSDKClient.instances.clear()
    return ClaudeEngine(
        base_url="http://127.0.0.1:8999",
        session_secret_hex=SECRET,
        client_factory=factory,
        config_dir=tmp_path,
        zai_token=zai_token,
        read_blocks=read_blocks,
    )
