import { describe, expect, test } from "vitest";
import { confirmIdOf, conversationIdOf } from "../test-helpers";
import {
  answerFailed, canStop, chatStatus, initialChat, modelLocked, shownModel, step,
  UNASKED_STOP_MESSAGE,
  type ChatEvent, type ChatState, type TurnId,
} from "./chatMachine";
import { createSseParser, type AssistantEvent } from "./sse";

function run(events: ChatEvent[], from: ChatState = initialChat()) {
  let state = from;
  const effects = [];
  for (const e of events) {
    const out = step(state, e);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

const c1 = conversationIdOf("c1");
const c2 = conversationIdOf("c2");
const conv1 = conversationIdOf("conv1");
const conv2 = conversationIdOf("conv2");

const streamed = (event: AssistantEvent, turn: TurnId = 1, at = 0): ChatEvent =>
  ({ type: "streamEvent", turn, event, at });

/** A send that opens `conversation` and starts streaming turn 1. */
function firstTurn(text: string, conversation = c1): ChatEvent[] {
  return [{ type: "send", text, at: 1 },
          { type: "created", turn: 1, id: conversation, model: "sonnet" }];
}

const turnDone = (turn: TurnId = 1): ChatEvent[] =>
  [streamed({ type: "turn_done", usage: null }, turn), { type: "streamEnded", turn }];

function confirmEvent(id: string): AssistantEvent {
  return { type: "confirm_request", confirm_id: confirmIdOf(id),
    ops_preview: "save_note(...)", preview: null };
}

const answer = (id: string, allow: boolean): ChatEvent =>
  ({ type: "answer", confirmId: confirmIdOf(id), allow });

const posted = (id: string, allow: boolean,
                { turn = 1, conversation = conv1, at = 0 } = {}): ChatEvent =>
  ({ type: "confirmPosted", turn, conversation, confirmId: confirmIdOf(id), allow, at });

const postFailed = (id: string, { turn = 1, notFound = false, message = "network down" } = {})
  : ChatEvent => ({ type: "confirmFailed", turn, confirmId: confirmIdOf(id), notFound, message });

const confirmEffect = (id: string, allow: boolean, turn: TurnId = 1) =>
  ({ kind: "confirm", turn, conversation: conv1, confirmId: confirmIdOf(id), allow });

/** Turn 1 of conv1, parked on cards c1 and c2. */
const twoCards: ChatEvent[] = [...firstTurn("please write", conv1),
  streamed(confirmEvent("c1")), streamed(confirmEvent("c2"))];

describe("chatMachine", () => {
  test("stop with no turn busy changes nothing", () => {
    const s = initialChat();
    expect(step(s, { type: "stop", at: 1 })).toEqual({ state: s, effects: [] });
  });

  const streaming: ChatEvent[] = [
    { type: "send", text: "hi", at: 1 },
    { type: "created", turn: 1, id: c1, model: "sonnet" },
  ];

  test("stop on a streaming turn posts a stop and stays stopping", () => {
    const { state, effects } = run([...streaming, { type: "stop", at: 2 }]);
    expect(effects.at(-1)).toEqual({ kind: "postStop", turn: 1, conversation: c1 });
    expect(effects.some((e) => e.kind === "abort")).toBe(false);
    expect(state.turn.phase).toBe("stopping");
    expect(chatStatus(state)).toBe("busy");
  });

  test("a stopped turn stays busy until both its stream and its stop POST are done", () => {
    const stopped = run([...streaming, { type: "stop", at: 2 }]).state;
    const turnStopped: ChatEvent = { type: "streamEvent", turn: 1, event: { type: "turn_stopped" }, at: 3 };
    const settled: ChatEvent = { type: "stopSettled", turn: 1 };
    // the stream's last word first, then the POST
    const a = run([turnStopped], stopped).state;
    expect(chatStatus(a)).toBe("busy");
    expect(chatStatus(run([settled], a).state)).toBe("idle");
    // the POST first, then the stream's end
    const b = run([settled], stopped).state;
    expect(chatStatus(b)).toBe("busy");
    expect(chatStatus(run([{ type: "streamEnded", turn: 1 }], b).state)).toBe("idle");
  });

  test("a turn_stopped the turn did not ask for ends it with a notice", () => {
    const { state } = run([...streaming,
      { type: "streamEvent", turn: 1, event: { type: "turn_stopped" }, at: 3 }]);
    expect(state.turn).toEqual({ phase: "idle" });
    expect(state.error).toBe(UNASKED_STOP_MESSAGE);
  });

  test("turn_stopped ends a stopping turn with no error", () => {
    const { state } = run([...streaming, { type: "stop", at: 2 }, { type: "stopSettled", turn: 1 },
      { type: "streamEvent", turn: 1, event: { type: "turn_stopped" }, at: 3 }]);
    expect(state.turn).toEqual({ phase: "idle" });
    expect(state.error).toBeNull();
    expect(state.conversation).toEqual({ kind: "open", id: c1, model: "sonnet" });
  });

  test("an error event ends a stopping turn without showing it", () => {
    const { state } = run([...streaming, { type: "stop", at: 2 }, { type: "stopSettled", turn: 1 },
      { type: "streamEvent", turn: 1, event: { type: "error", message: "stalled" }, at: 3 }]);
    expect(state.turn).toEqual({ phase: "idle" });
    expect(state.error).toBeNull();
  });

  test("a stopping turn's other events change nothing and keep it busy", () => {
    const before = run([...streaming, { type: "stop", at: 2 }]).state;
    const { state } = run([
      { type: "streamEvent", turn: 1, event: { type: "text_delta", text: "late" }, at: 3 },
      { type: "streamEvent", turn: 1, event: { type: "turn_done", usage: null }, at: 4 },
    ], before);
    expect(state).toEqual(before);
  });

  test("send while stopping is refused", () => {
    const before = run([...streaming, { type: "stop", at: 2 }]).state;
    expect(step(before, { type: "send", text: "again", at: 3 })).toEqual({ state: before, effects: [] });
  });

  test("New chat while stopping aborts the stream and deletes after it settles", () => {
    const before = run([...streaming, { type: "stop", at: 2 }]).state;
    expect(step(before, { type: "newChat" }).effects).toEqual([
      { kind: "abort", turn: 1 },
      { kind: "delete", conversation: c1, after: 1 },
    ]);
  });

  test("a conversation created for a turn New chat superseded is closed", () => {
    const { state, effects } = run([
      { type: "send", text: "hi", at: 1 },
      { type: "newChat" },
      { type: "created", turn: 1, id: c1, model: "sonnet" },
    ]);
    expect(state.conversation).toEqual({ kind: "none" });
    expect(effects.at(-1)).toEqual({ kind: "delete", conversation: c1, after: null });
  });

  test("the picker is locked while creating, and the server default lands nowhere", () => {
    const { state } = run([
      { type: "send", text: "hi", at: 1 },
      { type: "pickModel", model: "opus" },
      { type: "modelsLoaded", models: ["sonnet", "haiku"], default: "haiku" },
    ]);
    expect(modelLocked(state)).toBe(true);
    expect(shownModel(state)).toBe("sonnet");
    expect(state.models).toEqual(["sonnet", "haiku"]);
  });

  test("an empty models list keeps the fallback", () => {
    const { state } = run([{ type: "modelsLoaded", models: [], default: null }]);
    expect(state.models).toEqual(initialChat().models);
  });

  test("a create that fails after Stop drops the conversation with no error", () => {
    const { state } = run([
      { type: "send", text: "hi", at: 1 },
      { type: "stop", at: 2 },
      { type: "createFailed", turn: 1, message: "cap reached" },
    ]);
    expect(state.conversation).toEqual({ kind: "none" });
    expect(state.error).toBeNull();
    expect(chatStatus(state)).toBe("idle");
  });

  test("a 404 after Stop drops the conversation with no error and no re-create", () => {
    const { state, effects } = run([
      { type: "send", text: "hi", at: 1 },
      { type: "created", turn: 1, id: c1, model: "opus" },
      { type: "stop", at: 2 },
      { type: "streamFailed", turn: 1, failure: { kind: "notFound", message: "gone" } },
    ]);
    expect(effects.map((e) => e.kind)).toEqual(["create", "stream", "postStop"]);
    expect(state.conversation).toEqual({ kind: "none" });
    expect(state.picked).toBe("opus");
    expect(state.error).toBeNull();
  });

  test("a second 404 in one turn fails it and drops the conversation", () => {
    const { state, effects } = run([
      { type: "send", text: "hi", at: 1 },
      { type: "created", turn: 1, id: c1, model: "sonnet" },
      { type: "streamFailed", turn: 1, failure: { kind: "notFound", message: "gone" } },
      { type: "created", turn: 1, id: c2, model: "sonnet" },
      { type: "streamFailed", turn: 1, failure: { kind: "notFound", message: "gone again" } },
    ]);
    expect(effects.map((e) => e.kind)).toEqual(["create", "stream", "create", "stream"]);
    expect(state.conversation).toEqual({ kind: "none" });
    expect(state.error).toBe("gone again");
  });

  test("results for a turn that is not busy change nothing", () => {
    const { state: s } = run([
      { type: "send", text: "hi", at: 1 },
      { type: "created", turn: 1, id: c1, model: "sonnet" },
      { type: "streamEnded", turn: 1 },
    ]);
    const late: ChatEvent[] = [
      { type: "streamEvent", turn: 1, event: { type: "text_delta", text: "late" }, at: 3 },
      { type: "streamEnded", turn: 1 },
      { type: "streamFailed", turn: 1, failure: { kind: "failed", message: "boom" } },
      { type: "createFailed", turn: 1, message: "boom" },
      { type: "confirmFailed", turn: 1, confirmId: confirmIdOf("x"), notFound: true,
        message: "gone" },
    ];
    for (const e of late) {
      expect(step(s, e)).toEqual({ state: s, effects: [] });
    }
  });

  test("a send while busy, or of only spaces, starts nothing", () => {
    const { state: busy } = run([{ type: "send", text: "hi", at: 1 }]);
    expect(step(busy, { type: "send", text: "more", at: 2 }).effects).toEqual([]);
    expect(step(initialChat(), { type: "send", text: "  ", at: 2 }).effects).toEqual([]);
  });
});

describe("chatMachine stream events", () => {
  test("tool events render as tool items", () => {
    const { state } = run([...firstTurn("find x"),
      streamed({ type: "tool_started", tool_use_id: "t1", name: "search", summary: 'searching "x"' }),
      streamed({ type: "tool_finished", tool_use_id: "t1", name: "search", error: null,
                 declined: false }),
      streamed({ type: "text_delta", text: "found" }),
      ...turnDone()]);
    expect(state.items).toEqual([
      { kind: "user", text: "find x" },
      { kind: "tool", toolUseId: "t1", name: "search", summary: 'searching "x"',
        done: true, error: null, declined: false },
      { kind: "assistant", text: "found" },
    ]);
  });

  test("tool_finished marks the line with its own id, carrying its error", () => {
    const { state } = run([...firstTurn("edit"),
      streamed({ type: "tool_started", tool_use_id: "t1", name: "update_block", summary: "update_block" }),
      streamed({ type: "tool_started", tool_use_id: "t2", name: "update_block", summary: "update_block" }),
      streamed({ type: "tool_finished", tool_use_id: "t2", name: "update_block",
                 error: "nope", declined: false }),
      ...turnDone()]);
    expect(state.items).toEqual([
      { kind: "user", text: "edit" },
      { kind: "tool", toolUseId: "t1", name: "update_block", summary: "update_block",
        done: false, error: null, declined: false },
      { kind: "tool", toolUseId: "t2", name: "update_block", summary: "update_block",
        done: true, error: "nope", declined: false },
    ]);
  });

  test("a skipped batch's warning lands on its tool line", () => {
    const { state } = run([...firstTurn("edit"),
      streamed({ type: "tool_started", tool_use_id: "t1", name: "batch", summary: "batch" }),
      streamed({ type: "tool_finished", tool_use_id: "t1", name: "batch",
                 error: null, declined: false, warning: "warning: skipped 1 of 3 ops" }),
      ...turnDone()]);
    expect(state.items[1]).toEqual({
      kind: "tool", toolUseId: "t1", name: "batch", summary: "batch",
      done: true, error: null, declined: false,
      warning: "warning: skipped 1 of 3 ops" });
  });

  test("a declined write's line is done, with no error", () => {
    const { state } = run([...firstTurn("edit"),
      streamed({ type: "tool_started", tool_use_id: "t1", name: "update_block", summary: "update_block" }),
      streamed({ type: "tool_finished", tool_use_id: "t1", name: "update_block",
                 error: null, declined: true }),
      ...turnDone()]);
    expect(state.items[1]).toEqual(
      { kind: "tool", toolUseId: "t1", name: "update_block", summary: "update_block",
        done: true, error: null, declined: true });
  });

  test("a later turn's tool_finished marks an earlier turn's line", () => {
    const { state } = run([...firstTurn("one"),
      streamed({ type: "tool_started", tool_use_id: "t1", name: "update_block", summary: "update_block" }),
      ...turnDone(),
      { type: "send", text: "two", at: 2 },
      streamed({ type: "tool_finished", tool_use_id: "t1", name: "update_block",
                 error: "nope", declined: false }, 2),
      ...turnDone(2)]);
    expect(state.items[1]).toEqual(
      { kind: "tool", toolUseId: "t1", name: "update_block", summary: "update_block",
        done: true, error: "nope", declined: false });
  });

  test("a reused id marks the line not yet done, never a finished one", () => {
    const { state } = run([...firstTurn("edit"),
      streamed({ type: "tool_started", tool_use_id: "t1", name: "update_block", summary: "update_block" }),
      streamed({ type: "tool_finished", tool_use_id: "t1", name: "update_block",
                 error: "nope", declined: false }),
      streamed({ type: "tool_started", tool_use_id: "t1", name: "update_block", summary: "update_block" }),
      streamed({ type: "tool_finished", tool_use_id: "t1", name: "update_block",
                 error: null, declined: false }),
      ...turnDone()]);
    expect(state.items.slice(1)).toEqual([
      { kind: "tool", toolUseId: "t1", name: "update_block", summary: "update_block",
        done: true, error: "nope", declined: false },
      { kind: "tool", toolUseId: "t1", name: "update_block", summary: "update_block",
        done: true, error: null, declined: false },
    ]);
  });

  // Parsed from the wire, as a bundle one release apart from its server
  // would read it.
  function finishedFrame(data: string): ChatEvent[] {
    return createSseParser().push(`event: tool_finished\ndata: ${data}\n\n`)
      .map((event) => streamed(event));
  }

  test("a tool_finished without a name marks its line", () => {
    const { state } = run([...firstTurn("edit"),
      streamed({ type: "tool_started", tool_use_id: "t1", name: "update_block", summary: "update_block" }),
      ...finishedFrame('{"tool_use_id": "t1", "error": "nope", "declined": false}'),
      ...turnDone()]);
    expect(state.items[1]).toEqual(
      { kind: "tool", toolUseId: "t1", name: "update_block", summary: "update_block",
        done: true, error: "nope", declined: false });
  });

  test("a tool_finished that still carries a name marks its line", () => {
    const { state } = run([...firstTurn("edit"),
      streamed({ type: "tool_started", tool_use_id: "t1", name: "update_block", summary: "update_block" }),
      ...finishedFrame('{"tool_use_id": "t1", "name": "update_block", "error": null, '
        + '"declined": true}'),
      ...turnDone()]);
    expect(state.items[1]).toEqual(
      { kind: "tool", toolUseId: "t1", name: "update_block", summary: "update_block",
        done: true, error: null, declined: true });
  });

  test("a tool_finished with an unknown id changes no line", () => {
    const { state } = run([...firstTurn("edit"),
      streamed({ type: "tool_started", tool_use_id: "t1", name: "update_block", summary: "update_block" }),
      streamed({ type: "tool_finished", tool_use_id: "tX", name: "update_block",
                 error: "nope", declined: false }),
      ...turnDone()]);
    expect(state.items).toEqual([
      { kind: "user", text: "edit" },
      { kind: "tool", toolUseId: "t1", name: "update_block", summary: "update_block",
        done: false, error: null, declined: false },
    ]);
  });

  // The phase drives the busy line's label and its elapsed clock.
  test("phase events update the label mid-turn; turn end clears it", () => {
    const reasoning = run([...firstTurn("tidy this page"),
      streamed({ type: "phase", label: "reasoning" }, 1, 2)]).state;
    expect(reasoning.phase).toEqual({ label: "reasoning", since: 2 });
    const preparing = run([streamed({ type: "phase", label: "preparing save_note" }, 1, 3)],
                          reasoning).state;
    expect(preparing.phase).toEqual({ label: "preparing save_note", since: 3 });
    const done = run(turnDone(), preparing).state;
    expect(done.phase).toBeNull();
    expect(chatStatus(done)).toBe("idle");
  });

  // The pre-first-event window has no label by design (the busy line reads
  // plain "thinking…"), and a running tool's own line takes over from any
  // stale "preparing …" label.
  test("send opens an unlabelled phase; tool_started resets back to it", () => {
    const sent = run(firstTurn("find x")).state;
    expect(sent.phase).toEqual({ label: null, since: 1 });
    const preparing = run([streamed({ type: "phase", label: "preparing search" }, 1, 2)],
                          sent).state;
    expect(preparing.phase).toEqual({ label: "preparing search", since: 2 });
    const running = run([streamed({ type: "tool_started", tool_use_id: "t1", name: "search",
                                    summary: 'searching "x"' }, 1, 3)], preparing).state;
    expect(running.phase).toEqual({ label: null, since: 3 });
    expect(run(turnDone(), running).state.phase).toBeNull();
  });

  // The parked stretch was the user's silence, not the model's; its
  // duration must not leak into the next busy stretch's elapsed display.
  test("resuming from a confirm restarts the phase clock unlabelled", () => {
    const parked = run([...firstTurn("please write", conv1),
      streamed({ type: "phase", label: "preparing save_note" }, 1, 2),
      streamed(confirmEvent("t1"), 1, 2)]).state;
    expect(chatStatus(parked)).toBe("confirm");
    const resumed = run([answer("t1", true), posted("t1", true, { at: 5 })], parked).state;
    expect(chatStatus(resumed)).toBe("busy");
    expect(resumed.phase).toEqual({ label: null, since: 5 });
    expect(run(turnDone(), resumed).state.phase).toBeNull();
  });

  test("error event surfaces and unlocks", () => {
    const { state } = run([...firstTurn("hi"),
      streamed({ type: "error", message: "boom" }), { type: "streamEnded", turn: 1 }]);
    expect(state.error).toBe("boom");
    expect(chatStatus(state)).toBe("idle");
  });
});

describe("chatMachine confirm cards", () => {
  // A second confirm must wait behind the card on screen: replacing it would
  // change what Allow approves under the user's cursor.
  test("queues a second confirm behind the first", () => {
    const parked = run(twoCards).state;
    expect(chatStatus(parked)).toBe("confirm");
    expect(parked.confirms[0]?.confirmId).toBe("c1");
    expect(parked.confirms).toHaveLength(2);

    const answered = run([answer("c1", true)], parked);
    expect(answered.effects).toEqual([confirmEffect("c1", true)]);
    const next = run([posted("c1", true)], answered.state).state;
    expect(next.confirms[0]?.confirmId).toBe("c2");
    expect(next.confirms).toHaveLength(1);
    expect(chatStatus(next)).toBe("confirm");

    const done = run(turnDone(), next).state;
    expect(done.confirms).toEqual([]);
    expect(chatStatus(done)).toBe("idle");
  });

  test("answering the last queued confirm returns to busy", () => {
    const { state, effects } = run([...twoCards,
      answer("c1", false), posted("c1", false), answer("c2", true), posted("c2", true)]);
    expect(effects.filter((e) => e.kind === "confirm"))
      .toEqual([confirmEffect("c1", false), confirmEffect("c2", true)]);
    expect(state.confirms).toEqual([]);
    expect(chatStatus(state)).toBe("busy");
  });

  // The server reads each card's current text when it builds the card, so
  // a card waiting behind one the user allows was read before that write
  test("a card queued behind an allowed one counts it; a denied one does not", () => {
    const parked = run([...twoCards, streamed(confirmEvent("c3")), streamed(confirmEvent("c4"))])
      .state;
    expect(parked.confirms[0]?.allowedAhead).toBe(0);
    const one = run([answer("c1", true), posted("c1", true)], parked).state;
    expect(one.confirms[0]?.confirmId).toBe("c2");
    expect(one.confirms[0]?.allowedAhead).toBe(1);
    const two = run([answer("c2", false), posted("c2", false)], one).state;
    expect(two.confirms[0]?.confirmId).toBe("c3");
    expect(two.confirms[0]?.allowedAhead).toBe(1);
    const three = run([answer("c3", true), posted("c3", true)], two).state;
    expect(three.confirms[0]?.allowedAhead).toBe(2);
    // built after those Allows: the server's stamp says whether their
    // writes could still land after its read, so it counts them too
    const four = run([streamed(confirmEvent("c5")), answer("c4", false), posted("c4", false)],
                     three).state;
    expect(four.confirms[0]?.confirmId).toBe("c5");
    expect(four.confirms[0]?.allowedAhead).toBe(2);
  });

  test("a new turn counts no Allow from the last", () => {
    const { state } = run([...firstTurn("one", conv1), streamed(confirmEvent("c1")),
      answer("c1", true), posted("c1", true), ...turnDone(),
      { type: "send", text: "two", at: 2 }, streamed(confirmEvent("c2"), 2)]);
    expect(state.confirms[0]?.confirmId).toBe("c2");
    expect(state.confirms[0]?.allowedAhead).toBe(0);
  });

  test("a stopped turn's Allows count for the next turn's cards", () => {
    const { state } = run([...firstTurn("one", conv1), streamed(confirmEvent("c1")),
      answer("c1", true), posted("c1", true),
      { type: "stop", at: 2 }, streamed({ type: "turn_stopped" }), { type: "stopSettled", turn: 1 },
      { type: "streamEnded", turn: 1 },
      { type: "send", text: "two", at: 3 }, streamed(confirmEvent("c2"), 2)]);
    expect(state.confirms[0]?.confirmId).toBe("c2");
    expect(state.confirms[0]?.allowedAhead).toBe(1);
  });

  test("a new conversation counts no Allow from the old one", () => {
    const { state } = run([...firstTurn("one", conv1), streamed(confirmEvent("c1")),
      answer("c1", true), posted("c1", true), { type: "newChat" },
      { type: "send", text: "two", at: 2 },
      { type: "created", turn: 2, id: conv2, model: "sonnet" },
      streamed(confirmEvent("c2"), 2)]);
    expect(state.confirms[0]?.confirmId).toBe("c2");
    expect(state.confirms[0]?.allowedAhead).toBe(0);
  });

  test("an Allow that fails to post counts for no card behind it", () => {
    const failed = run([...twoCards, answer("c1", true), postFailed("c1")]).state;
    expect(failed.confirms[0]?.confirmId).toBe("c1");
    // only the retry that posted counts, not the failed post before it
    const { state } = run([answer("c1", true), posted("c1", true)], failed);
    expect(state.confirms[0]?.confirmId).toBe("c2");
    expect(state.confirms[0]?.allowedAhead).toBe(1);
  });

  // Advancing before the POST settles would let a failure swap the card
  // back under the cursor, so the answered card stays, marked posting.
  test("the answered card stays until its answer is posted", () => {
    const parked = run(twoCards).state;
    expect(parked.confirms[0]?.answer).toBeNull();
    const inFlight = run([answer("c1", true)], parked).state;
    expect(inFlight.confirms[0]?.answer).toEqual({ allow: true, state: "posting" });
    expect(inFlight.confirms[0]?.confirmId).toBe("c1");
    expect(inFlight.confirms).toHaveLength(2);
    expect(chatStatus(inFlight)).toBe("confirm");
    const next = run([posted("c1", true)], inFlight).state;
    expect(next.confirms[0]?.answer).toBeNull();
    expect(next.confirms[0]?.confirmId).toBe("c2");
    expect(next.confirms).toHaveLength(1);
  });

  // A second click, from a fresh render, while the first answer is in
  // flight must not answer anything: not c1 again, and not c2 behind it.
  test("an answer while one is in flight posts nothing", () => {
    const inFlight = run([...twoCards, answer("c1", true)]).state;
    expect(step(inFlight, answer("c1", true)).effects).toEqual([]);
    const { state, effects } = run([answer("c1", true), posted("c1", true)], inFlight);
    expect(effects).toEqual([]);
    expect(state.confirms[0]?.confirmId).toBe("c2");
    expect(chatStatus(state)).toBe("confirm");
  });

  test("a failed answer leaves the same card showing, not the next", () => {
    const inFlight = run([...twoCards, answer("c1", false)]);
    expect(inFlight.state.confirms[0]?.confirmId).toBe("c1");
    const failed = run([postFailed("c1")], inFlight.state).state;
    expect(failed.confirms[0]?.confirmId).toBe("c1");
    expect(failed.confirms).toHaveLength(2);
    expect(failed.confirms[0]?.answer).toEqual({ allow: false, state: "failed" });
    expect(chatStatus(failed)).toBe("confirm");
    expect(failed.error).toBe("network down");

    // the user can answer the same card again
    const again = run([answer("c1", false), posted("c1", false)], failed);
    expect([...inFlight.effects, ...again.effects].filter((e) => e.kind === "confirm"))
      .toEqual([confirmEffect("c1", false), confirmEffect("c1", false)]);
    expect(again.state.confirms[0]?.confirmId).toBe("c2");
  });

  // The server may hold a failed answer already and ignores a changed one,
  // so the machine records what it posted and the card can offer only that
  // again, however often the card remounts.
  test("the head records the decision once it is posted", () => {
    const parked = run(twoCards).state;
    expect(parked.confirms[0]?.answer).toBeNull();
    const inFlight = run([answer("c1", true)], parked).state;
    expect(inFlight.confirms[0]?.answer?.allow).toBe(true);
    const failed = run([postFailed("c1")], inFlight).state;
    expect(failed.confirms[0]?.confirmId).toBe("c1");
    expect(failed.confirms[0]?.answer?.allow).toBe(true);

    // a changed answer posts nothing; the same one goes again
    expect(step(failed, answer("c1", false)).effects).toEqual([]);
    const retried = run([answer("c1", true)], failed);
    expect(retried.effects).toEqual([confirmEffect("c1", true)]);
    const next = run([posted("c1", true)], retried.state).state;
    expect(next.confirms[0]?.confirmId).toBe("c2");
    expect(next.confirms[0]?.answer).toBeNull();
  });

  test("an answer refused while one posts records nothing", () => {
    const inFlight = run([...twoCards, answer("c1", true)]).state;
    const refused = step(inFlight, answer("c1", false));
    expect(refused.effects).toEqual([]);
    expect(refused.state.confirms[0]?.answer).toEqual({ allow: true, state: "posting" });
  });

  // The server can finish the turn before the answer's POST returns; the
  // next turn's card must still take an answer.
  test("a turn that ends while an answer is in flight leaves the next answerable", () => {
    const ended = run([...firstTurn("please write", conv1), streamed(confirmEvent("c1")),
      answer("c1", true), { type: "streamEnded", turn: 1 }]).state;
    expect(ended.confirms).toEqual([]);
    expect(canStop(ended)).toBe(false);
    const { state, effects } = run([{ type: "send", text: "and again", at: 2 },
      streamed(confirmEvent("c3"), 2), answer("c3", true)], ended);
    expect(state.confirms[0]?.confirmId).toBe("c3");
    expect(effects.at(-1)).toEqual(confirmEffect("c3", true, 2));
  });

  test("a reaped conversation drops the whole queue", () => {
    const { state } = run([...twoCards, answer("c1", true),
      postFailed("c1", { notFound: true, message: "gone" })]);
    expect(state.confirms).toEqual([]);
    expect(chatStatus(state)).toBe("idle");
    expect(state.error).toMatch(/expired/);
  });
});

describe("chatMachine confirm answer", () => {
  const posting = (allow: boolean) => ({ allow, state: "posting" });
  const failedWith = (allow: boolean) => ({ allow, state: "failed" });

  test("an answer marks the head posting and posts it", () => {
    const { state, effects } = step(run(twoCards).state, answer("c1", false));
    expect(state.confirms[0]?.answer).toEqual(posting(false));
    expect(state.confirms[1]?.answer).toBeNull();
    expect(effects).toEqual([confirmEffect("c1", false)]);
  });

  test("a second answer while the head posts posts nothing", () => {
    const inFlight = run([...twoCards, answer("c1", true)]).state;
    for (const allow of [true, false]) {
      expect(step(inFlight, answer("c1", allow))).toEqual({ state: inFlight, effects: [] });
    }
  });

  test("a failed post marks the head failed and keeps it at the head", () => {
    const { state } = run([...twoCards, answer("c1", true), postFailed("c1")]);
    expect(state.confirms.map((c) => c.confirmId)).toEqual(["c1", "c2"]);
    expect(state.confirms[0]?.answer).toEqual(failedWith(true));
    expect(state.error).toBe("network down");
  });

  // The server may already hold the failed POST's answer and ignores a
  // changed one, so only the same answer may go again.
  test("after a failure only the same answer posts again", () => {
    const failed = run([...twoCards, answer("c1", true), postFailed("c1")]).state;
    expect(step(failed, answer("c1", false))).toEqual({ state: failed, effects: [] });
    const retried = step(failed, answer("c1", true));
    expect(retried.effects).toEqual([confirmEffect("c1", true)]);
    expect(retried.state.confirms[0]?.answer).toEqual(posting(true));
  });

  test("a posted answer removes the head", () => {
    const { state } = run([...twoCards, answer("c1", true), postFailed("c1"),
      answer("c1", true), posted("c1", true)]);
    expect(state.confirms.map((c) => c.confirmId)).toEqual(["c2"]);
    expect(state.confirms[0]?.answer).toBeNull();
  });

  // After a 404 re-creates the conversation mid-turn, the old card's POST
  // can still fail while a new card heads the queue.
  test("a confirmFailed for a card that is not the head marks nothing", () => {
    const recreated = run([...firstTurn("please write", conv1), streamed(confirmEvent("c1")),
      answer("c1", true),
      { type: "streamFailed", turn: 1, failure: { kind: "notFound", message: "gone" } },
      { type: "created", turn: 1, id: conv2, model: "sonnet" },
      streamed(confirmEvent("c2"))]).state;
    const waiting = step(recreated, postFailed("c1")).state;
    expect(waiting.confirms[0]?.answer).toBeNull();
    const inFlight = run([answer("c2", false)], recreated).state;
    const stillPosting = step(inFlight, postFailed("c1")).state;
    expect(stillPosting.confirms[0]?.answer).toEqual(posting(false));
  });

  test.each([
    ["idle", false, []],
    ["busy with no card", true, firstTurn("hi")],
    ["a card waiting unanswered", false, twoCards],
    ["answer posting", true, [...twoCards, answer("c1", true)]],
    ["answer failed", true, [...twoCards, answer("c1", true), postFailed("c1")]],
    ["stopping", true, [...twoCards, { type: "stop", at: 2 }]],
  ] as const)("canStop when %s: %s", (_name, stoppable, events) => {
    expect(canStop(run([...events]).state)).toBe(stoppable);
  });

  test("answerFailed only for a failed answer", () => {
    const parked = run(twoCards).state;
    const inFlight = run([answer("c1", true)], parked).state;
    const failed = run([postFailed("c1")], inFlight).state;
    expect([parked, inFlight, failed].map((s) => answerFailed(s.confirms[0]!)))
      .toEqual([false, false, true]);
  });
});

describe("chatMachine picker", () => {
  test("the server's default lands after the send: the picker keeps the conversation's model",
    () => {
      const sent = run([{ type: "send", text: "hi", at: 1 }]);
      expect(sent.effects).toEqual([{ kind: "create", turn: 1, model: "sonnet" }]);
      expect(modelLocked(sent.state)).toBe(true);
      const loaded = run([{ type: "modelsLoaded", models: ["sonnet", "opus", "haiku", "fable"],
                            default: "haiku" }], sent.state).state;
      expect(shownModel(loaded)).toBe("sonnet");
      const done = run([{ type: "created", turn: 1, id: c1, model: "sonnet" }, ...turnDone()],
                       loaded).state;
      expect(shownModel(done)).toBe("sonnet");
    });

  test("the picker shows the model the server says the conversation runs", () => {
    const { state } = run([{ type: "send", text: "hi", at: 1 },
      { type: "created", turn: 1, id: c1, model: "opus" }, ...turnDone()]);
    expect(shownModel(state)).toBe("opus");
  });

  test("a 404 whose re-create fails leaves the picker unlocked", () => {
    const { state } = run([...firstTurn("hi"),
      { type: "streamFailed", turn: 1, failure: { kind: "notFound", message: "gone" } },
      { type: "createFailed", turn: 1, message: "cap reached" }]);
    expect(state.error).toContain("cap reached");
    expect(modelLocked(state)).toBe(false);
  });

  test("a conversation reaped under a card leaves the picker unlocked", () => {
    const { state } = run([...firstTurn("please write", conv1), streamed(confirmEvent("t1")),
      answer("t1", true), postFailed("t1", { notFound: true, message: "gone" })]);
    expect(state.error).toMatch(/expired/);
    expect(modelLocked(state)).toBe(false);
  });
});
