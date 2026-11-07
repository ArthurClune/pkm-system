"""Stateful property test of an assistant conversation's turn phase, driven
through `AssistantService` and the real `ClaudeEngine` against a scripted
CLI, on a virtual clock (`props.virtual_loop`).

The scripted CLI behaves as the bundled CLI does: one turn per query, a
write's tool_use parks it in `can_use_tool` until the decision, and an
interrupt is acknowledged only after any parked decision. The rule drawn
for each Stop or stall says how the interrupt ends an open turn: its
aborted ResultMessage after the ack (what CLI 2.1.301 does), before it,
never, or no ack at all (a hang or a raise). The process can also die, or
close its output, at any step.

The model is assistant.md § The turn phase, not the engine: a conversation
whose interrupt went unacknowledged, whose drain found no result, or whose
stream raised or ended is retired, and any other stays usable. Every turn's
events belong to its own prompt and a finished turn ends on its own
result. A parked confirm is on the live consumer's screen or answered. The
running writes cover every allowed write whose result the CLI has not
written yet."""
from __future__ import annotations

import asyncio
import contextlib
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from claude_agent_sdk import (AssistantMessage, CLIConnectionError,
                              PermissionResultAllow, StreamEvent,
                              ToolPermissionContext, ToolResultBlock,
                              ToolUseBlock, UserMessage)
from hypothesis import event, settings, strategies as st
from hypothesis.stateful import (RuleBasedStateMachine, initialize, invariant,
                                 precondition, rule)

from fake_sdk_client import (AFTER_ACK_S, FakeSDKClient, aborted_result,
                             make_engine, make_result)
from pkm.assistant import claude_engine
from pkm.assistant.claude_engine import ClaudeConversation
from pkm.assistant.events import (AssistantEvent, ConfirmRequest, ErrorEvent,
                                  TextDelta, ToolFinished, ToolStarted,
                                  TurnDone)
from pkm.assistant.service import AssistantService
from pkm.contracts.responses import ConversationId
from props.harness import examples
from props.virtual_loop import VirtualTimeLoop

pytestmark = pytest.mark.proptest

ACKED = ("after_ack", "before_ack", "never")
ORDERS = (*ACKED, "unacked", "raises")
WRITE_TOOL = "mcp__pkm__save_note"
# Loop passes for a step's effects to reach the consumer. The clock does
# not move while a coroutine is ready, so no timer fires during them.
SETTLE_PASSES = 100
# The pause before a person sends again, in which a result the CLI writes
# after its ack lands in the SDK's buffer.
USER_PAUSE_S = 1.0


class ScriptedCLI(FakeSDKClient):
    def __init__(self, options):
        super().__init__(options)
        self.prompt: str | None = None  # the open turn's
        self.next_interrupt = "after_ack"
        self.parked: set[asyncio.Task] = set()
        self.running: list[str] = []  # allowed writes without a result
        self.seq = 0
        # an interrupt went unanswered, or answered with the turn never
        # ending: whatever the harness does next is unknown
        self.untrusted = False
        self.queried_untrusted = False

    def next_id(self) -> int:
        self.seq += 1
        return self.seq

    async def query(self, text):
        if self.untrusted:
            self.queried_untrusted = True
        await super().query(text)
        self.prompt = text

    async def interrupt(self):
        self.interrupts += 1
        if self.dead:
            raise CLIConnectionError("harness exited")
        order = self.next_interrupt
        if order == "unacked":
            self.untrusted = True
            await asyncio.Event().wait()
        if order == "raises":
            self.untrusted = True
            raise RuntimeError("interrupt failed")
        if self.parked:
            await asyncio.wait(set(self.parked))
        if not self.turn_open:
            return
        if order == "never":
            self.untrusted = True
            self._close_turn()
            return
        msgs: list[object] = [UserMessage(content=[ToolResultBlock(
            tool_use_id=tid, content="interrupted", is_error=True)])
            for tid in self.running]
        msgs.append(aborted_result(usage={"tag": self.prompt}))
        self._close_turn()
        if order == "before_ack":
            self.feed(*msgs)
        else:
            asyncio.get_running_loop().call_later(AFTER_ACK_S, self.feed, *msgs)

    def _close_turn(self) -> None:
        self.turn_open = False
        self.prompt = None
        self.running.clear()

    def text(self) -> None:
        self.feed(StreamEvent(uuid="u", session_id="s1", event={
            "type": "content_block_delta",
            "delta": {"type": "text_delta",
                      "text": f"{self.prompt}:{self.next_id()}"}}))

    def write(self, conv) -> None:
        tid = f"{self.prompt}-w{self.next_id()}"
        self.feed(AssistantMessage(content=[ToolUseBlock(
            id=tid, name=WRITE_TOOL, input={"text": tid})], model="m"))
        task = asyncio.get_running_loop().create_task(conv.can_use_tool(
            WRITE_TOOL, {"text": tid}, ToolPermissionContext(tool_use_id=tid)))
        self.parked.add(task)
        task.add_done_callback(lambda t: self._decided(tid, t))

    def _decided(self, tid: str, task: asyncio.Task) -> None:
        self.parked.discard(task)
        if task.cancelled() or not self.turn_open:
            return
        if isinstance(task.result(), PermissionResultAllow):
            self.running.append(tid)
        else:
            self.feed(UserMessage(content=[ToolResultBlock(
                tool_use_id=tid, content="declined", is_error=True)]))

    def tool_result(self) -> None:
        tid = self.running.pop(0)
        self.feed(UserMessage(content=[ToolResultBlock(
            tool_use_id=tid, content="ok", is_error=False)]))

    def finish(self) -> None:
        self.feed(make_result(usage={"tag": self.prompt}))
        self.prompt = None


@dataclass
class Turn:
    prompt: str
    task: asyncio.Task
    events: list[AssistantEvent] = field(default_factory=list)


def assert_of(prompt: str, events: list[AssistantEvent]) -> None:
    """Every event a turn showed belongs to its own prompt."""
    for ev in events:
        if isinstance(ev, TextDelta):
            assert ev.text.startswith(f"{prompt}:"), (prompt, ev)
        elif isinstance(ev, (ToolStarted, ToolFinished)):
            assert ev.tool_use_id.startswith(f"{prompt}-"), (prompt, ev)
        elif isinstance(ev, TurnDone):
            assert ev.usage == {"tag": prompt}, (prompt, ev)


class TurnMachine(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.loop = VirtualTimeLoop()
        self.tmp = Path(tempfile.mkdtemp(prefix="pkm-turnprop-"))
        self._real_cli = claude_engine.harness_cli
        claude_engine.harness_cli = lambda: "/no/claude"
        self.service = AssistantService(make_engine(self.tmp, factory=ScriptedCLI))
        self.cid: ConversationId | None = None
        self.cli: ScriptedCLI | None = None
        self.clis: list[ScriptedCLI] = []
        # the model: whether the service should still hold the conversation
        self.alive = False
        self.turn: Turn | None = None
        self.turns = 0
        self.last_end = "none"

    def run(self, coro):
        return self.loop.run_until_complete(coro)

    async def settle(self) -> None:
        for _ in range(SETTLE_PASSES):
            await asyncio.sleep(0)

    def act(self, step) -> None:
        """Run a CLI step on the loop, then let its effects reach the
        consumer."""
        async def go():
            step()
            await self.settle()
        self.run(go())

    def teardown(self) -> None:
        try:
            self.run(self.service.close_all())
            pending = [t for t in asyncio.all_tasks(self.loop) if not t.done()]
            for t in pending:
                t.cancel()
            if pending:
                self.run(asyncio.wait(pending))
        finally:
            self.loop.close()
            claude_engine.harness_cli = self._real_cli
            shutil.rmtree(self.tmp, ignore_errors=True)

    def conv(self) -> ClaudeConversation | None:
        entry = self.service._entries.get(self.cid) if self.cid else None
        if entry is None:
            return None
        assert isinstance(entry.handle, ClaudeConversation)
        return entry.handle

    def c(self) -> ScriptedCLI:
        assert self.cli is not None
        return self.cli

    def t(self) -> Turn:
        assert self.turn is not None
        return self.turn

    def id(self) -> ConversationId:
        assert self.cid is not None
        return self.cid

    async def _new_chat(self) -> None:
        self.cid, _ = await self.service.create("sonnet")
        cli = FakeSDKClient.instances[-1]
        assert isinstance(cli, ScriptedCLI)
        self.cli = cli
        self.clis.append(cli)
        self.alive = True

    @initialize()
    def start(self) -> None:
        self.run(self._new_chat())

    def live(self) -> bool:
        return self.turn is not None

    def open_unparked(self) -> bool:
        return (self.turn is not None and self.cli is not None
                and self.cli.prompt is not None and not self.cli.parked)

    def _end_turn(self, how: str) -> Turn:
        turn = self.turn
        assert turn is not None
        assert turn.task.done(), f"turn {turn.prompt} did not end ({how})"
        assert_of(turn.prompt, turn.events)
        self.turn = None
        self.last_end = how
        return turn

    # -- the user ---------------------------------------------------------

    @precondition(lambda self: not self.live())
    @rule()
    def send(self) -> None:
        event(f"send after: {self.last_end}")
        if self.last_end == "stop after_ack":
            event("send after a stop whose result came after the ack")

        async def go():
            await asyncio.sleep(USER_PAUSE_S)
            if not self.alive:
                assert self.cid not in self.service._entries
                await self._new_chat()
            assert self.cli is not None
            dead_before = self.c().dead
            self.turns += 1
            prompt = f"p{self.turns}"
            sink: list[AssistantEvent] = []
            task = asyncio.get_running_loop().create_task(
                self._consume(self.service.send(self.id(), prompt), sink))
            self.turn = Turn(prompt, task, sink)
            await self.settle()
            return dead_before

        dead_before = self.run(go())
        assert self.turn is not None and self.cli is not None
        if dead_before:
            event("send to a harness that died between turns")
            turn = self._end_turn("refused")
            assert [type(ev) for ev in turn.events] == [ErrorEvent]
            assert turn.prompt not in self.c().queries
            self.alive = False
            assert self.cid not in self.service._entries
            return
        assert not self.t().task.done(), (
            f"turn {self.t().prompt} ended at once: {self.t().events}")
        assert self.c().queries[-1] == self.t().prompt

    async def _consume(self, stream, sink: list[AssistantEvent]) -> None:
        async for ev in stream:
            sink.append(ev)

    @precondition(lambda self: self.live() and bool(self.cli and self.c().parked))
    @rule(allow=st.booleans())
    def answer(self, allow: bool) -> None:
        assert self.turn is not None and self.cli is not None
        conv = self.conv()
        assert conv is not None
        shown = [ev.confirm_id for ev in self.t().events
                 if isinstance(ev, ConfirmRequest)
                 and ev.confirm_id in conv._pending]
        assert shown, "a parked write whose card the consumer never got"
        event(f"write {'allowed' if allow else 'declined'}")
        self.service.confirm(self.id(), shown[-1], allow)
        self.run(self.settle())

    @precondition(lambda self: self.live())
    @rule(order=st.sampled_from(ORDERS), race=st.booleans())
    def stop(self, order: str, race: bool) -> None:
        assert self.turn is not None and self.cli is not None
        cli = self.cli
        race = race and self.open_unparked() and not cli.running
        if race and order not in ACKED:
            race = False
        if race:
            event("stop as the harness finished the turn")
        elif cli.parked:
            event("stop with a parked confirm")
        if cli.running:
            event("stop with an allowed write running")
        turn_open = cli.turn_open and not race
        event(f"stop {order}" + ("" if turn_open else " (turn closed)"))
        cli.next_interrupt = order

        async def go():
            if race:
                cli.finish()  # the turn ends as Stop lands
            self.t().task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.t().task

        self.run(go())
        self._end_turn(f"stop {order}" if turn_open else "stop")
        if turn_open and order not in ("after_ack", "before_ack"):
            self.alive = False
        assert (self.cid in self.service._entries) == self.alive

    # -- the CLI ----------------------------------------------------------

    @precondition(lambda self: self.open_unparked())
    @rule()
    def emit_text(self) -> None:
        self.act(self.c().text)
        assert not self.t().task.done()

    @precondition(lambda self: self.open_unparked())
    @rule()
    def emit_write(self) -> None:
        conv = self.conv()
        self.act(lambda: self.c().write(conv))

    @precondition(lambda self: self.open_unparked() and bool(self.c().running))
    @rule()
    def emit_tool_result(self) -> None:
        self.act(self.c().tool_result)

    @precondition(lambda self: self.open_unparked() and not self.c().running)
    @rule()
    def finish(self) -> None:
        prompt = self.c().prompt
        self.act(self.c().finish)
        turn = self._end_turn("finished")
        assert turn.events[-1] == TurnDone(usage={"tag": prompt})
        event("turn finished")

    @precondition(lambda self: self.live() and self.c().prompt is not None)
    @rule(order=st.sampled_from(ORDERS))
    def stall(self, order: str) -> None:
        cli = self.c()
        cli.next_interrupt = order
        parked = bool(cli.parked)
        self.run(asyncio.sleep(claude_engine.STALL_TIMEOUT_S * 1.5))
        self.run(self.settle())
        if parked:
            event("stall suspended by a parked confirm")
            assert not self.t().task.done(), "a stall fired on the user's silence"
            return
        event(f"stall {order}")
        turn = self._end_turn(f"stall {order}")
        assert turn.events[-1] == ErrorEvent(
            message=claude_engine.stall_message(claude_engine.STALL_TIMEOUT_S))
        if order not in ("after_ack", "before_ack"):
            self.alive = False
        assert (self.cid in self.service._entries) == self.alive

    @precondition(lambda self: self.alive and not self.c().dead)
    @rule(how=st.sampled_from(["dies", "eof"]), odds=st.integers(0, 3))
    def harness_lost(self, how: str, odds: int) -> None:
        if odds:
            return  # rarer than the other steps, or few turns outlive it
        self.act(self.c().die if how == "dies" else self.c().end_stream)
        if self.turn is None:
            event(f"harness {how} between turns")
            return  # the next send() finds out
        event(f"harness {how} mid-turn")
        turn = self._end_turn(f"lost {how}")
        assert isinstance(turn.events[-1], ErrorEvent)
        self.alive = False
        assert self.cid not in self.service._entries

    # -- invariants ---------------------------------------------------------

    @invariant()
    def live_turn_shows_only_its_own(self) -> None:
        if self.turn is not None:
            assert_of(self.t().prompt, self.t().events)
            assert not any(isinstance(ev, ErrorEvent) for ev in self.t().events)

    @invariant()
    def parked_confirms_are_on_screen(self) -> None:
        conv = self.conv()
        if conv is None:
            return
        shown = ({ev.confirm_id for ev in self.t().events
                  if isinstance(ev, ConfirmRequest)} if self.turn else set())
        for confirm_id, fut in conv._pending.items():
            assert fut.done() or confirm_id in shown, (
                f"{confirm_id} parked with no card on screen")

    @invariant()
    def running_writes_cover_the_unfinished(self) -> None:
        conv = self.conv()
        if conv is None or self.cli is None or not self.alive:
            return
        assert set(self.c().running) <= conv._running_writes

    @invariant()
    def an_untrusted_harness_is_never_reused(self) -> None:
        assert not any(cli.queried_untrusted for cli in self.clis)

    @invariant()
    def retirement_matches_the_model(self) -> None:
        if self.turn is None and self.cid is not None:
            assert (self.cid in self.service._entries) == self.alive


TestTurnPhase = TurnMachine.TestCase
TestTurnPhase.settings = settings(max_examples=examples("assistant_turn"),
                                  stateful_step_count=30)
