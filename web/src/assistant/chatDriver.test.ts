import { describe, expect, test, vi } from "vitest";
import type { ConversationId } from "../api/brands";
import { ApiError } from "../api/client";
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

  // The back-off chose to retry before Stop landed; the retry would reach
  // the server after Stop.
  test("a Stop during a 409's back-off sends no retry", async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const driver = createChatDriver(() => {}, fakeClient({
        streamMessage: (_id, text) => {
          sent.push(text);
          return Promise.reject(new ApiError(409, "/messages", "conversation busy"));
        },
      }));
      void driver.dispatch({ type: "send", text: "hi", at: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toEqual(["hi"]);

      void driver.dispatch({ type: "stop", at: 0 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toEqual(["hi"]);
      expect(driver.current().turn.phase).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
});
