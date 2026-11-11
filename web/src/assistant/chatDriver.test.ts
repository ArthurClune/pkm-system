import { describe, expect, test, vi } from "vitest";
import type { ConversationId } from "../api/brands";
import { conversationIdOf } from "../test-helpers";
import { createChatDriver, type ChatClient } from "./chatDriver";

const c1 = conversationIdOf("c1");

/** Lets every pending callback and microtask run. */
const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function fakeClient(overrides: Partial<ChatClient>): ChatClient {
  return {
    createConversation: () => Promise.resolve({ id: c1, model: "sonnet" }),
    streamMessage: () => new Promise<void>(() => {}),
    stopTurn: () => Promise.resolve(),
    deleteConversation: () => Promise.resolve(),
    confirmTool: () => Promise.resolve(),
    ...overrides,
  };
}

describe("createChatDriver", () => {
  // The server must see the dropped connection before the conversation is
  // closed, or the DELETE races the turn still running on it.
  test("newChat sends the DELETE only after the aborted stream settles", async () => {
    let release!: () => void;
    let opened = false;
    const deleted: ConversationId[] = [];
    const driver = createChatDriver(() => {}, fakeClient({
      // ignores its abort signal: settles only when the test releases it
      streamMessage: (_id, _text, _onEvent, _signal, onOpen) => {
        onOpen?.();
        opened = true;
        return new Promise<void>((resolve) => { release = resolve; });
      },
      deleteConversation: (id) => {
        deleted.push(id);
        return Promise.resolve();
      },
    }));
    void driver.dispatch({ type: "send", text: "hi", at: 0 });
    await vi.waitFor(() => expect(opened).toBe(true));

    const reset = driver.dispatch({ type: "newChat" });
    await tick();
    await tick();
    expect(deleted).toEqual([]);

    release();
    await reset;
    expect(deleted).toEqual([c1]);
  });
});
