"""Stateful property test of an assistant conversation's turn phase, driven
through `AssistantService` and the real `ClaudeEngine` against a scripted
CLI, on a virtual clock (`props.virtual_loop`).

The scripted CLI behaves as the bundled CLI does: one turn per query, a
write's tool_use parks it in `can_use_tool` until the decision, and an
interrupt is acknowledged only after any parked decision. The rule drawn
for each Stop or stall says how the interrupt ends an open turn: its
aborted ResultMessage after the ack (what CLI 2.1.301 does), before it,
never, or no ack at all (a hang or a raise). A Stop is the user's (the
stream stays open and ends on its own) or a dropped connection. Its
interrupt can be held while the clock passes the stall watchdog's
deadline, and a query can be held while the consumer is cancelled or the
user stops. The process can also die, or close its output, at any step.

The model is assistant.md § The turn phase, not the engine: a conversation
whose query was abandoned, whose interrupt went unacknowledged, whose drain
found no result, or whose stream raised or ended is retired, and any other
stays usable. Every turn's events belong to its own prompt and a finished
turn ends on its own result; a turn the user stopped ends on
`TurnStopped`, unless a stall's interrupt came first, and no other turn
shows one. No turn sends a second interrupt. A parked confirm is on the
live consumer's screen or answered. The running writes cover every allowed
write whose result the CLI has not written yet."""
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
from hypothesis import settings, strategies as st
from hypothesis.stateful import (RuleBasedStateMachine, initialize, invariant,
                                 precondition, rule,
                                 run_state_machine_as_test)

from fake_sdk_client import (AFTER_ACK_S, FakeSDKClient, aborted_result,
                             make_engine, make_result)
from hostile import count, event
from pkm.assistant import claude_engine
from pkm.assistant.claude_engine import ClaudeConversation
from pkm.assistant.events import (AssistantEvent, ConfirmRequest, ErrorEvent,
                                  TextDelta, ToolFinished, ToolStarted,
                                  TurnDone, TurnStopped)
from pkm.assistant.service import AssistantService
from pkm.contracts.responses import ConversationId
from props.harness import examples, merge_floors
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
        # held: an interrupt waits for release() before the CLI answers it,
        # so a step can land while it is in flight
        self.held = False
        self.release = asyncio.Event()
        # held_query: query() writes the prompt, then waits for
        # query_release before it returns
        self.held_query = False
        self.query_release = asyncio.Event()

    def next_id(self) -> int:
        self.seq += 1
        return self.seq

    async def query(self, text):
        if self.untrusted:
            self.queried_untrusted = True
        await super().query(text)
        self.prompt = text
        if self.held_query:
            await self.query_release.wait()

    async def interrupt(self):
        self.interrupts += 1
        if self.dead:
            raise CLIConnectionError("harness exited")
        if self.held:
            await self.release.wait()
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
    # the CLI's interrupt count when the turn began
    cli: ScriptedCLI | None = None
    interrupts_before: int = 0

    def interrupts(self) -> int:
        return 0 if self.cli is None else (self.cli.interrupts
                                           - self.interrupts_before)


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
        # a stall split into steps: its interrupt "pending" or its drain
        # "draining", under the drawn interrupt order
        self.stall_state: str | None = None
        self.stall_order = "after_ack"
        # When the stall watchdog would next fire: the pump reads its
        # window from _read_timeout at each pass.
        self.stall_deadline = 0.0
        real = self._real_read_timeout = ClaudeConversation._read_timeout
        machine = self

        def watched(self: ClaudeConversation) -> float:
            window = real(self)
            machine.stall_deadline = machine.loop.time() + window
            return window

        ClaudeConversation._read_timeout = watched

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
            ClaudeConversation._read_timeout = self._real_read_timeout
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
        count("example")
        self.run(self._new_chat())

    def live(self) -> bool:
        return self.turn is not None

    def open_unparked(self) -> bool:
        return (self.turn is not None and self.cli is not None
                and self.cli.prompt is not None and not self.cli.parked
                and self.stall_state is None)

    def _end_turn(self, how: str) -> Turn:
        turn = self.turn
        assert turn is not None
        assert turn.task.done(), f"turn {turn.prompt} did not end ({how})"
        assert_of(turn.prompt, turn.events)
        assert turn.interrupts() <= 1, (
            f"turn {turn.prompt} sent {turn.interrupts()} interrupts ({how})")
        stopped = [ev for ev in turn.events if isinstance(ev, TurnStopped)]
        if how.startswith("user stop"):
            assert stopped == [turn.events[-1]], (how, turn.events)
        else:
            assert not stopped, (how, turn.events)
        self.turn = None
        self.last_end = how
        self.stall_state = None
        if self.cli is not None:
            self.cli.held = False
            self.cli.held_query = False
        return turn

    # -- the user ---------------------------------------------------------

    @precondition(lambda self: not self.live())
    @rule()
    def send(self) -> None:
        event(f"send after: {self.last_end}")
        if self.last_end.endswith("stop after_ack"):
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
            self.turn = Turn(prompt, task, sink, self.c(),
                             self.c().interrupts)
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
    @rule(order=st.sampled_from(ORDERS), race=st.booleans(),
          hold=st.booleans(), via=st.sampled_from(["user", "disconnect"]))
    def stop(self, order: str, race: bool, hold: bool, via: str) -> None:
        """The user's Stop (the stream stays open and ends on its own) or
        a dropped connection. `hold`: the interrupt is held while the
        clock passes the stall watchdog's deadline."""
        assert self.turn is not None and self.cli is not None
        cli = self.cli
        turn = self.turn
        stalling = self.stall_state
        if stalling:
            # the stall's own interrupt is the only one the harness needs
            order = self.stall_order
            event(f"{via} stop with the stall's interrupt {stalling} "
                  f"({order})")
        race = race and self.open_unparked() and not cli.running
        if race and order not in ACKED:
            race = False
        hold = hold and not race and self.open_unparked()
        if race:
            event("stop as the harness finished the turn")
        elif cli.parked:
            event("stop with a parked confirm")
        if cli.running:
            event("stop with an allowed write running")
        turn_open = (cli.turn_open and not race) or stalling is not None
        if not stalling:
            event(f"{via} stop {order}" + ("" if turn_open else " (turn closed)"))
        cli.next_interrupt = order
        if hold:
            cli.held = True
            cli.release = asyncio.Event()

        async def go() -> bool:
            if race:
                cli.finish()  # the turn ends as Stop lands
            if hold:
                # Stop just before the watchdog would fire
                await asyncio.sleep(
                    max(0.0, self.stall_deadline - self.loop.time() - 1))
            if via == "user":
                self.service.stop(self.id())
            else:
                turn.task.cancel()
            await self.settle()
            crossed = False
            if hold:
                await asyncio.sleep(2)
                crossed = self.loop.time() > self.stall_deadline
            cli.release.set()  # the CLI answers interrupts in flight
            await asyncio.wait({turn.task}, timeout=(
                claude_engine.INTERRUPT_TIMEOUT_S
                + claude_engine.DRAIN_TIMEOUT_S + 1))
            with contextlib.suppress(asyncio.CancelledError):
                await turn.task
            return crossed

        if self.run(go()):
            event(f"{via} stop's interrupt held past the stall deadline")
        how = f"stop {order}" if turn_open else "stop"
        if via == "user":
            # a stall's interrupt came first: the turn is the stall's
            how = f"stall {order}, then a user stop" if stalling else f"user {how}"
        if (race and via == "user" and turn.events
                and turn.events[-1] == TurnDone(usage={"tag": turn.prompt})):
            # the pump read the result before it heard the Stop
            event("user stop as the harness finished: the turn's own result")
            how = "finished as a user stop landed"
        ended = self._end_turn(how)
        if via == "user" and stalling:
            assert ended.events[-1] == ErrorEvent(
                message=claude_engine.stall_message(
                    claude_engine.STALL_TIMEOUT_S)), ended.events
        if turn_open and order not in ("after_ack", "before_ack"):
            self.alive = False
        assert (self.cid in self.service._entries) == self.alive

    @precondition(lambda self: not self.live() and self.alive)
    @rule()
    def stop_with_no_turn_open(self) -> None:
        cli = self.c()
        before = cli.interrupts
        event("user stop with no turn open")

        async def go():
            self.service.stop(self.id())
            await self.settle()

        self.run(go())
        assert cli.interrupts == before
        assert self.cid in self.service._entries

    @precondition(lambda self: not self.live() and self.alive
                  and not self.c().dead)
    @rule()
    def stop_before_the_turn_starts(self) -> None:
        """The stop POST lands after the messages route reserved the turn
        and before the response body's first step."""
        cli = self.c()
        before = (cli.interrupts, len(cli.queries))
        self.turns += 1
        prompt = f"p{self.turns}"
        sink: list[AssistantEvent] = []
        event("user stop before the reserved turn starts")

        async def go() -> asyncio.Task:
            await asyncio.sleep(USER_PAUSE_S)
            stream = self.service.send(self.id(), prompt)
            self.service.stop(self.id())
            task = asyncio.get_running_loop().create_task(
                self._consume(stream, sink))
            await self.settle()
            return task

        task = self.run(go())
        self.turn = Turn(prompt, task, sink, cli, cli.interrupts)
        ended = self._end_turn("user stop before it started")
        assert ended.events == [TurnStopped()], ended.events
        assert (cli.interrupts, len(cli.queries)) == before
        assert self.cid in self.service._entries

    @precondition(lambda self: not self.live() and self.alive
                  and not self.c().dead)
    @rule(how=st.sampled_from(["cancel", "user"]),
          order=st.sampled_from(ORDERS))
    def query_cut_short(self, how: str, order: str) -> None:
        """A send whose query() is still being written when the consumer is
        cancelled or the user stops."""
        cli = self.c()
        cli.held_query = True
        cli.query_release = asyncio.Event()
        cli.next_interrupt = order
        self.turns += 1
        prompt = f"p{self.turns}"
        sink: list[AssistantEvent] = []

        async def start() -> asyncio.Task:
            await asyncio.sleep(USER_PAUSE_S)
            task = asyncio.get_running_loop().create_task(
                self._consume(self.service.send(self.id(), prompt), sink))
            await self.settle()
            return task

        task = self.run(start())
        self.turn = Turn(prompt, task, sink, cli, cli.interrupts)
        conv = self.conv()
        assert conv is not None and conv.phase == "querying"
        assert cli.queries[-1] == prompt and not task.done()
        if how == "cancel":
            event("consumer cancelled while query() is pending")

            async def cancel():
                task.cancel()
                await self.settle()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

            self.run(cancel())
            # the prompt reached the CLI: a turn may run that nobody reads
            cli.untrusted = True
            self._end_turn("query cancelled")
            self.alive = False
            assert self.cid not in self.service._entries
            return
        event(f"user stop while query() is pending ({order})")

        async def stop():
            self.service.stop(self.id())
            await self.settle()
            cli.query_release.set()
            await asyncio.wait({task}, timeout=(
                claude_engine.INTERRUPT_TIMEOUT_S
                + claude_engine.DRAIN_TIMEOUT_S + 1))

        self.run(stop())
        ended = self._end_turn(f"user stop {order}")
        assert ended.events == [TurnStopped()], ended.events
        if order not in ("after_ack", "before_ack"):
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

    @precondition(lambda self: self.live() and self.c().prompt is not None
                  and self.stall_state is None)
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

    @precondition(lambda self: self.open_unparked())
    @rule(order=st.sampled_from(ORDERS))
    def stall_begins(self, order: str) -> None:
        """The watchdog fires and its interrupt is in flight."""
        cli = self.c()
        cli.next_interrupt = order
        cli.held = True
        cli.release = asyncio.Event()
        before = cli.interrupts

        async def until_the_watchdog_fires():
            # The pump's silence window may have opened before this step,
            # e.g. while a confirm was parked, so step the clock in seconds
            # rather than sleep a fixed span past INTERRUPT_TIMEOUT_S.
            for _ in range(int(claude_engine.STALL_TIMEOUT_S) + 2):
                if cli.interrupts > before:
                    break
                await asyncio.sleep(1.0)
            await self.settle()

        self.run(until_the_watchdog_fires())
        assert cli.interrupts > before and not self.t().task.done()
        self.stall_state, self.stall_order = "pending", order
        event("stall interrupt pending")

    @precondition(lambda self: self.stall_state == "pending")
    @rule()
    def stall_acked(self) -> None:
        """The CLI answers the stall's interrupt; the clock stays put, so an
        after-ack result or a drain timeout has not come yet."""
        cli = self.c()
        order = self.stall_order
        cli.held = False
        self.act(cli.release.set)
        if order == "unacked":
            assert not self.t().task.done()
            return
        if order in ("after_ack", "never"):
            assert not self.t().task.done()
            self.stall_state = "draining"
            event("stall drain open")
            return
        self._stall_ended(order)

    @precondition(lambda self: self.stall_state is not None)
    @rule()
    def stall_runs_out(self) -> None:
        self.c().release.set()
        self.run(asyncio.sleep(claude_engine.INTERRUPT_TIMEOUT_S
                               + claude_engine.DRAIN_TIMEOUT_S + 1))
        self.run(self.settle())
        self._stall_ended(self.stall_order)

    def _stall_ended(self, order: str) -> None:
        event(f"split stall {order}")
        turn = self._end_turn(f"stall {order}")
        assert turn.events[-1] == ErrorEvent(
            message=claude_engine.stall_message(claude_engine.STALL_TIMEOUT_S))
        if order not in ("after_ack", "before_ack"):
            self.alive = False
        assert (self.cid in self.service._entries) == self.alive

    @precondition(lambda self: self.alive and not self.c().dead
                  and self.stall_state is None)
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
    def one_interrupt_per_turn(self) -> None:
        if self.turn is not None:
            assert self.t().interrupts() <= 1, (
                f"turn {self.t().prompt} sent {self.t().interrupts()} "
                "interrupts")

    @invariant()
    def an_untrusted_harness_is_never_reused(self) -> None:
        assert not any(cli.queried_untrusted for cli in self.clis)

    @invariant()
    def retirement_matches_the_model(self) -> None:
        if self.turn is None and self.cid is not None:
            assert (self.cid in self.service._entries) == self.alive


# Floors: half the lowest share over 30 unseeded merge runs, 2026-11-10.
# No floor, under five events in some run:
#   "disconnect stop with the stall's interrupt draining (after_ack)"
#   "disconnect stop with the stall's interrupt draining (never)"
#   "disconnect stop with the stall's interrupt pending (before_ack)"
#   "disconnect stop with the stall's interrupt pending (never)"
#   "disconnect stop with the stall's interrupt pending (raises)"
#   "send after: stall before_ack, then a user stop"
#   "send after: stall raises, then a user stop"
#   "user stop with the stall's interrupt draining (after_ack)"
#   "user stop with the stall's interrupt draining (never)"
#   "user stop with the stall's interrupt pending (after_ack)"
#   "user stop with the stall's interrupt pending (never)"
#   "user stop with the stall's interrupt pending (raises)"
# No floor, under ten in some run, so half of it is noise:
#   "disconnect stop after_ack (turn closed)"
#   "disconnect stop with the stall's interrupt pending (after_ack)"
#   "disconnect stop with the stall's interrupt pending (unacked)"
#   "send after: stall after_ack, then a user stop"
#   "send after: stall never, then a user stop"
#   "send after: stall unacked, then a user stop"
#   "stop with an allowed write running"
#   "user stop before_ack (turn closed)"
#   "user stop never (turn closed)"
#   "user stop with the stall's interrupt pending (before_ack)"
#   "user stop with the stall's interrupt pending (unacked)"
# No floor, a run under half the lowest share is too likely:
#   "disconnect stop never (turn closed)"
#   "send after: stop before_ack"
@merge_floors({
    "consumer cancelled while query() is pending": 0.136,
    "disconnect stop after_ack": 0.011,
    "disconnect stop before_ack": 0.005,
    "disconnect stop before_ack (turn closed)": 0.004,
    "disconnect stop never": 0.005,
    "disconnect stop raises": 0.011,
    "disconnect stop unacked": 0.015,
    "disconnect stop's interrupt held past the stall deadline": 0.027,
    "harness dies between turns": 0.044,
    "harness dies mid-turn": 0.049,
    "harness eof between turns": 0.027,
    "harness eof mid-turn": 0.026,
    "send after a stop whose result came after the ack": 0.04,
    "send after: finished": 0.08,
    "send after: finished as a user stop landed": 0.008,
    "send after: lost dies": 0.048,
    "send after: lost eof": 0.025,
    "send after: none": 0.16,
    "send after: query cancelled": 0.09,
    "send after: refused": 0.04,
    "send after: stall after_ack": 0.045,
    "send after: stall before_ack": 0.02,
    "send after: stall never": 0.042,
    "send after: stall raises": 0.042,
    "send after: stall unacked": 0.039,
    "send after: stop": 0.006,
    "send after: stop after_ack": 0.005,
    "send after: stop never": 0.012,
    "send after: stop raises": 0.019,
    "send after: stop unacked": 0.02,
    "send after: user stop after_ack": 0.024,
    "send after: user stop before it started": 0.1,
    "send after: user stop before_ack": 0.01,
    "send after: user stop never": 0.023,
    "send after: user stop raises": 0.03,
    "send after: user stop unacked": 0.03,
    "send to a harness that died between turns": 0.04,
    "split stall after_ack": 0.022,
    "split stall before_ack": 0.009,
    "split stall never": 0.007,
    "split stall raises": 0.012,
    "split stall unacked": 0.006,
    "stall after_ack": 0.056,
    "stall before_ack": 0.027,
    "stall drain open": 0.019,
    "stall interrupt pending": 0.164,
    "stall never": 0.027,
    "stall raises": 0.024,
    "stall suspended by a parked confirm": 0.07,
    "stall unacked": 0.021,
    "stop as the harness finished the turn": 0.039,
    "stop with a parked confirm": 0.046,
    "turn finished": 0.167,
    "user stop after_ack": 0.026,
    "user stop after_ack (turn closed)": 0.004,
    "user stop as the harness finished: the turn's own result": 0.014,
    "user stop before the reserved turn starts": 0.699,
    "user stop before_ack": 0.009,
    "user stop never": 0.011,
    "user stop raises": 0.018,
    "user stop unacked": 0.017,
    "user stop while query() is pending (after_ack)": 0.017,
    "user stop while query() is pending (before_ack)": 0.016,
    "user stop while query() is pending (never)": 0.009,
    "user stop while query() is pending (raises)": 0.015,
    "user stop while query() is pending (unacked)": 0.015,
    "user stop with no turn open": 1.059,
    "user stop's interrupt held past the stall deadline": 0.024,
    "write allowed": 0.025,
    "write declined": 0.058,
}, "example")
def test_turn_phase() -> None:
    run_state_machine_as_test(TurnMachine, settings=settings(
        max_examples=examples("assistant_turn"), stateful_step_count=30))
