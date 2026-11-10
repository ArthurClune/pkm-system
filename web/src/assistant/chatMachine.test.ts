import { describe, expect, test } from "vitest";
import { confirmIdOf, conversationIdOf } from "../test-helpers";
import {
  chatStatus, initialChat, modelLocked, shownModel, step,
  type ChatEvent, type ChatState,
} from "./chatMachine";

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
    expect(state.turn).toEqual({ phase: "stopping", id: 1 });
    expect(chatStatus(state)).toBe("busy");
  });

  test("turn_stopped ends a stopping turn with no error", () => {
    const { state } = run([...streaming, { type: "stop", at: 2 },
      { type: "streamEvent", turn: 1, event: { type: "turn_stopped" }, at: 3 }]);
    expect(state.turn).toEqual({ phase: "idle" });
    expect(state.error).toBeNull();
    expect(state.conversation).toEqual({ kind: "open", id: c1, model: "sonnet" });
  });

  test("an error event ends a stopping turn without showing it", () => {
    const { state } = run([...streaming, { type: "stop", at: 2 },
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
