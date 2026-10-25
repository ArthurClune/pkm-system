import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../api/client";
import type { AssistantEvent } from "./sse";

const mocks = vi.hoisted(() => ({
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  confirmTool: vi.fn(),
  streamMessage: vi.fn(),
  closeConversationBeacon: vi.fn(),
  fetchModels: vi.fn(),
}));
vi.mock("./client", () => mocks);

import { useAssistant } from "./useAssistant";
import { confirmIdOf } from "../test-helpers";

let latest: ReturnType<typeof useAssistant>;
function Harness() {
  latest = useAssistant();
  return <div data-testid="status">{latest.status}</div>;
}

afterEach(() => vi.clearAllMocks());

function feed(events: AssistantEvent[]) {
  mocks.streamMessage.mockImplementation(
    async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
      for (const ev of events) onEvent(ev);
    },
  );
}

function confirmEvent(id: string): AssistantEvent {
  return { type: "confirm_request", confirm_id: confirmIdOf(id),
    ops_preview: "save_note(...)", preview: null };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("useAssistant", () => {
  test("models are not fetched until ensureModels is called (panel open)", async () => {
    const d = deferredValue<{ models: string[]; default: string }>();
    mocks.fetchModels.mockReturnValue(d.promise);
    render(<Harness />);
    // mounting alone (app load, panel closed) must not hit the network
    expect(mocks.fetchModels).not.toHaveBeenCalled();
    expect(latest.models).toEqual(["sonnet", "opus", "haiku", "fable"]);
    act(() => latest.ensureModels());
    act(() => latest.ensureModels());
    expect(mocks.fetchModels).toHaveBeenCalledTimes(1); // idempotent while pending
    await act(async () => d.resolve({ models: ["sonnet", "opus", "haiku", "fable", "glm"], default: "sonnet" }));
    expect(latest.models).toEqual(["sonnet", "opus", "haiku", "fable", "glm"]);
    act(() => latest.ensureModels());
    expect(mocks.fetchModels).toHaveBeenCalledTimes(1); // and after success
  });

  test("a failed models fetch keeps the fallback and retries on the next open", async () => {
    mocks.fetchModels.mockRejectedValueOnce(new Error("offline"));
    mocks.fetchModels.mockResolvedValueOnce({ models: ["sonnet", "opus", "haiku", "fable", "glm"], default: "sonnet" });
    render(<Harness />);
    await act(async () => latest.ensureModels());
    expect(latest.models).toEqual(["sonnet", "opus", "haiku", "fable"]);
    await act(async () => latest.ensureModels());
    expect(latest.models).toEqual(["sonnet", "opus", "haiku", "fable", "glm"]);
  });

  test("adopts the server's default model unless the user already picked one", async () => {
    mocks.fetchModels.mockResolvedValue({ models: ["sonnet", "opus", "haiku", "fable"], default: "haiku" });
    render(<Harness />);
    await act(async () => latest.ensureModels());
    expect(latest.model).toBe("haiku");
  });

  test("does not clobber a user's picker choice with the server default", async () => {
    const d = deferredValue<{ models: string[]; default: string }>();
    mocks.fetchModels.mockReturnValue(d.promise);
    render(<Harness />);
    act(() => latest.ensureModels());
    act(() => latest.setModel("opus"));
    await act(async () => d.resolve({ models: ["sonnet", "opus", "haiku", "fable"], default: "haiku" }));
    expect(latest.model).toBe("opus");
  });

  test("send creates conversation lazily and accumulates deltas", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    feed([
      { type: "text_delta", text: "he" },
      { type: "text_delta", text: "y" },
      { type: "turn_done", usage: null },
    ]);
    render(<Harness />);
    await act(() => latest.send("hi"));
    expect(mocks.createConversation).toHaveBeenCalledWith("sonnet");
    expect(latest.items).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hey" },
    ]);
    expect(latest.status).toBe("idle");
    expect(latest.modelLocked).toBe(true);

    // second send reuses the conversation
    await act(() => latest.send("again"));
    expect(mocks.createConversation).toHaveBeenCalledTimes(1);
  });

  test("tool events render as tool items", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    feed([
      { type: "tool_started", tool_use_id: "t1", name: "search", summary: 'searching "x"' },
      { type: "tool_finished", tool_use_id: "t1", name: "search", error: null, declined: false },
      { type: "text_delta", text: "found" },
      { type: "turn_done", usage: null },
    ]);
    render(<Harness />);
    await act(() => latest.send("find x"));
    expect(latest.items).toEqual([
      { kind: "user", text: "find x" },
      { kind: "tool", toolUseId: "t1", name: "search", summary: 'searching "x"',
        done: true, error: null, declined: false },
      { kind: "assistant", text: "found" },
    ]);
  });

  test("confirm_request pauses, respondConfirm answers", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    let release!: () => void;
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent(confirmEvent("t1"));
        await new Promise<void>((r) => (release = r));
        onEvent({ type: "text_delta", text: "Saved." });
        onEvent({ type: "turn_done", usage: null });
      },
    );
    mocks.confirmTool.mockResolvedValue(undefined);
    render(<Harness />);
    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = latest.send("please write");
      await Promise.resolve();
    });
    expect(latest.status).toBe("confirm");
    expect(latest.pendingConfirm).toEqual(
      { confirmId: "t1", opsPreview: "save_note(...)", preview: null,
        sentDecision: null, allowedAhead: 0 });
    await act(async () => {
      await latest.respondConfirm(true);
      release();
      await sendDone;
    });
    expect(mocks.confirmTool).toHaveBeenCalledWith("c1", "t1", true);
    expect(latest.status).toBe("idle");
    expect(latest.pendingConfirm).toBeNull();
  });

  test("respondConfirm restores pending state on confirmTool failure", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent(confirmEvent("t1"));
        await new Promise<void>(() => {}); // turn stays open awaiting the confirm decision
      },
    );
    mocks.confirmTool.mockRejectedValue(new Error("network down"));
    render(<Harness />);
    await act(async () => {
      void latest.send("please write");
      await Promise.resolve();
    });
    expect(latest.pendingConfirm).toEqual(
      { confirmId: "t1", opsPreview: "save_note(...)", preview: null,
        sentDecision: null, allowedAhead: 0 });
    await act(() => latest.respondConfirm(true));
    expect(latest.pendingConfirm).toEqual(
      { confirmId: "t1", opsPreview: "save_note(...)", preview: null,
        sentDecision: true, allowedAhead: 0 });
    expect(latest.status).toBe("confirm");
    expect(latest.error).toBe("network down");
  });

  // A second confirm must wait behind the card on screen: replacing it would
  // change what Allow approves under the user's cursor.
  test("queues a second confirm behind the first", async () => {
    mocks.createConversation.mockResolvedValue({ id: "conv1", model: "sonnet" });
    let release!: () => void;
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent(confirmEvent("c1"));
        onEvent(confirmEvent("c2"));
        await new Promise<void>((r) => (release = r));
        onEvent({ type: "turn_done", usage: null });
      },
    );
    mocks.confirmTool.mockResolvedValue(undefined);
    render(<Harness />);
    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = latest.send("please write");
      await Promise.resolve();
    });
    expect(latest.status).toBe("confirm");
    expect(latest.pendingConfirm?.confirmId).toBe("c1");
    expect(latest.pendingConfirmCount).toBe(2);

    await act(() => latest.respondConfirm(true));
    expect(mocks.confirmTool).toHaveBeenLastCalledWith("conv1", "c1", true);
    expect(latest.pendingConfirm?.confirmId).toBe("c2");
    expect(latest.pendingConfirmCount).toBe(1);
    expect(latest.status).toBe("confirm");

    await act(async () => {
      release();
      await sendDone;
    });
    expect(latest.pendingConfirm).toBeNull();
    expect(latest.pendingConfirmCount).toBe(0);
    expect(latest.status).toBe("idle");
  });

  test("answering the last queued confirm returns to busy", async () => {
    mocks.createConversation.mockResolvedValue({ id: "conv1", model: "sonnet" });
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent(confirmEvent("c1"));
        onEvent(confirmEvent("c2"));
        await new Promise<void>(() => {});
      },
    );
    mocks.confirmTool.mockResolvedValue(undefined);
    render(<Harness />);
    await act(async () => {
      void latest.send("please write");
      await Promise.resolve();
    });
    await act(() => latest.respondConfirm(false));
    await act(() => latest.respondConfirm(true));
    expect(mocks.confirmTool.mock.calls).toEqual([["conv1", "c1", false], ["conv1", "c2", true]]);
    expect(latest.pendingConfirm).toBeNull();
    expect(latest.status).toBe("busy");
  });

  // The server reads each card's current text when it builds the card, so
  // a card waiting behind one the user allows was read before that write
  test("a card queued behind an allowed one counts it; a denied one does not",
    async () => {
      mocks.createConversation.mockResolvedValue({ id: "conv1", model: "sonnet" });
      let emit!: (ev: AssistantEvent) => void;
      mocks.streamMessage.mockImplementation(
        async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
          emit = onEvent;
          onEvent(confirmEvent("c1"));
          onEvent(confirmEvent("c2"));
          onEvent(confirmEvent("c3"));
          onEvent(confirmEvent("c4"));
          await new Promise<void>(() => {});
        },
      );
      mocks.confirmTool.mockResolvedValue(undefined);
      render(<Harness />);
      await act(async () => {
        void latest.send("please write");
        await Promise.resolve();
      });
      expect(latest.pendingConfirm?.allowedAhead).toBe(0);
      await act(() => latest.respondConfirm(true));
      expect(latest.pendingConfirm?.confirmId).toBe("c2");
      expect(latest.pendingConfirm?.allowedAhead).toBe(1);
      await act(() => latest.respondConfirm(false));
      expect(latest.pendingConfirm?.confirmId).toBe("c3");
      expect(latest.pendingConfirm?.allowedAhead).toBe(1);
      await act(() => latest.respondConfirm(true));
      expect(latest.pendingConfirm?.allowedAhead).toBe(2);
      // built after those Allows: the server's stamp says whether their
      // writes could still land after its read, so it counts them too
      act(() => emit(confirmEvent("c5")));
      await act(() => latest.respondConfirm(false));
      expect(latest.pendingConfirm?.confirmId).toBe("c5");
      expect(latest.pendingConfirm?.allowedAhead).toBe(2);
    });

  test("a new turn counts no Allow from the last", async () => {
    mocks.createConversation.mockResolvedValue({ id: "conv1", model: "sonnet" });
    const turnOne = deferredValue<void>();
    let calls = 0;
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        calls += 1;
        if (calls === 1) {
          onEvent(confirmEvent("c1"));
          await turnOne.promise;
          onEvent({ type: "turn_done", usage: null });
          return;
        }
        onEvent(confirmEvent("c2"));
        await new Promise<void>(() => {});
      },
    );
    mocks.confirmTool.mockResolvedValue(undefined);
    render(<Harness />);
    let first!: Promise<void>;
    await act(async () => {
      first = latest.send("one");
      await Promise.resolve();
    });
    await act(() => latest.respondConfirm(true));
    await act(async () => {
      turnOne.resolve();
      await first;
    });
    await act(async () => {
      void latest.send("two");
      await Promise.resolve();
    });
    expect(latest.pendingConfirm?.confirmId).toBe("c2");
    expect(latest.pendingConfirm?.allowedAhead).toBe(0);
  });

  // Turn one shows c1 and runs until aborted; turn two shows c2.
  function stoppedThenNext() {
    let calls = 0;
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void,
             signal?: AbortSignal) => {
        calls += 1;
        if (calls === 1) {
          onEvent(confirmEvent("c1"));
          await new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
          return;
        }
        onEvent(confirmEvent("c2"));
        await new Promise<void>(() => {});
      },
    );
    mocks.confirmTool.mockResolvedValue(undefined);
  }

  test("a stopped turn's Allows count for the next turn's cards", async () => {
    mocks.createConversation.mockResolvedValue({ id: "conv1", model: "sonnet" });
    stoppedThenNext();
    render(<Harness />);
    let first!: Promise<void>;
    await act(async () => {
      first = latest.send("one");
      await Promise.resolve();
    });
    await act(() => latest.respondConfirm(true));
    await act(async () => {
      latest.stop();
      await first;
    });
    await act(async () => {
      void latest.send("two");
      await Promise.resolve();
    });
    expect(latest.pendingConfirm?.confirmId).toBe("c2");
    expect(latest.pendingConfirm?.allowedAhead).toBe(1);
  });

  test("a new conversation counts no Allow from the old one", async () => {
    mocks.createConversation
      .mockResolvedValueOnce({ id: "conv1", model: "sonnet" })
      .mockResolvedValueOnce({ id: "conv2", model: "sonnet" });
    mocks.deleteConversation.mockResolvedValue(undefined);
    stoppedThenNext();
    render(<Harness />);
    await act(async () => {
      void latest.send("one");
      await Promise.resolve();
    });
    await act(() => latest.respondConfirm(true));
    await act(() => latest.newChat());
    await act(async () => {
      void latest.send("two");
      await Promise.resolve();
    });
    expect(latest.pendingConfirm?.confirmId).toBe("c2");
    expect(latest.pendingConfirm?.allowedAhead).toBe(0);
  });

  test("an Allow that fails to post counts for no card behind it", async () => {
    mocks.createConversation.mockResolvedValue({ id: "conv1", model: "sonnet" });
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent(confirmEvent("c1"));
        onEvent(confirmEvent("c2"));
        await new Promise<void>(() => {});
      },
    );
    mocks.confirmTool.mockRejectedValueOnce(new Error("network down"));
    mocks.confirmTool.mockResolvedValue(undefined);
    render(<Harness />);
    await act(async () => {
      void latest.send("please write");
      await Promise.resolve();
    });
    await act(() => latest.respondConfirm(true));
    expect(latest.pendingConfirm?.confirmId).toBe("c1");
    // only the retry that posted counts, not the failed post before it
    await act(() => latest.respondConfirm(true));
    expect(latest.pendingConfirm?.confirmId).toBe("c2");
    expect(latest.pendingConfirm?.allowedAhead).toBe(1);
  });

  function parkTwoConfirms() {
    mocks.createConversation.mockResolvedValue({ id: "conv1", model: "sonnet" });
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent(confirmEvent("c1"));
        onEvent(confirmEvent("c2"));
        await new Promise<void>(() => {});
      },
    );
  }

  // Advancing before the POST settles would let a failure swap the card
  // back under the cursor, so the answered card stays, marked answering.
  test("the answered card stays until its answer is posted", async () => {
    parkTwoConfirms();
    const post = deferredValue<void>();
    mocks.confirmTool.mockReturnValue(post.promise);
    render(<Harness />);
    await act(async () => {
      void latest.send("please write");
      await Promise.resolve();
    });
    expect(latest.answering).toBe(false);
    let answered!: Promise<void>;
    act(() => { answered = latest.respondConfirm(true); });
    expect(latest.answering).toBe(true);
    expect(latest.pendingConfirm?.confirmId).toBe("c1");
    expect(latest.pendingConfirmCount).toBe(2);
    expect(latest.status).toBe("confirm");
    await act(async () => {
      post.resolve();
      await answered;
    });
    expect(latest.answering).toBe(false);
    expect(latest.pendingConfirm?.confirmId).toBe("c2");
    expect(latest.pendingConfirmCount).toBe(1);
  });

  // A second click, from a fresh render, while the first answer is in
  // flight must not answer anything: not c1 again, and not c2 behind it.
  test("an answer while one is in flight posts nothing", async () => {
    parkTwoConfirms();
    const post = deferredValue<void>();
    mocks.confirmTool.mockReturnValue(post.promise);
    render(<Harness />);
    await act(async () => {
      void latest.send("please write");
      await Promise.resolve();
    });
    let answered!: Promise<void>;
    act(() => { answered = latest.respondConfirm(true); });
    await act(() => latest.respondConfirm(true));
    expect(mocks.confirmTool.mock.calls).toEqual([["conv1", "c1", true]]);
    await act(async () => {
      post.resolve();
      await answered;
    });
    expect(mocks.confirmTool.mock.calls).toEqual([["conv1", "c1", true]]);
    expect(latest.pendingConfirm?.confirmId).toBe("c2");
    expect(latest.status).toBe("confirm");
  });

  test("a failed answer leaves the same card showing, not the next", async () => {
    parkTwoConfirms();
    const post = deferredValue<void>();
    mocks.confirmTool.mockReturnValueOnce(post.promise);
    render(<Harness />);
    await act(async () => {
      void latest.send("please write");
      await Promise.resolve();
    });
    let answered!: Promise<void>;
    act(() => { answered = latest.respondConfirm(false); });
    expect(latest.pendingConfirm?.confirmId).toBe("c1");
    await act(async () => {
      post.reject(new Error("network down"));
      await answered;
    });
    expect(latest.pendingConfirm?.confirmId).toBe("c1");
    expect(latest.pendingConfirmCount).toBe(2);
    expect(latest.answering).toBe(false);
    expect(latest.status).toBe("confirm");
    expect(latest.error).toBe("network down");

    // the user can answer the same card again
    mocks.confirmTool.mockResolvedValueOnce(undefined);
    await act(() => latest.respondConfirm(false));
    expect(mocks.confirmTool.mock.calls).toEqual(
      [["conv1", "c1", false], ["conv1", "c1", false]]);
    expect(latest.pendingConfirm?.confirmId).toBe("c2");
  });

  // The server may hold a failed answer already and ignores a changed one,
  // so the hook records what it posted and the card can offer only that again,
  // however often the card remounts.
  test("the head records the decision once it is posted", async () => {
    parkTwoConfirms();
    const post = deferredValue<void>();
    mocks.confirmTool.mockReturnValueOnce(post.promise);
    render(<Harness />);
    await act(async () => {
      void latest.send("please write");
      await Promise.resolve();
    });
    expect(latest.pendingConfirm?.sentDecision).toBeNull();
    let answered!: Promise<void>;
    act(() => { answered = latest.respondConfirm(true); });
    expect(latest.pendingConfirm?.sentDecision).toBe(true);
    await act(async () => {
      post.reject(new Error("network down"));
      await answered;
    });
    expect(latest.pendingConfirm?.confirmId).toBe("c1");
    expect(latest.pendingConfirm?.sentDecision).toBe(true);

    // a changed answer posts nothing; the same one goes again
    await act(() => latest.respondConfirm(false));
    expect(mocks.confirmTool.mock.calls).toEqual([["conv1", "c1", true]]);
    mocks.confirmTool.mockResolvedValueOnce(undefined);
    await act(() => latest.respondConfirm(true));
    expect(mocks.confirmTool.mock.calls).toEqual(
      [["conv1", "c1", true], ["conv1", "c1", true]]);
    expect(latest.pendingConfirm?.confirmId).toBe("c2");
    expect(latest.pendingConfirm?.sentDecision).toBeNull();
  });

  test("an answer the hook does not post records nothing", async () => {
    parkTwoConfirms();
    render(<Harness />);
    await act(async () => {
      void latest.send("please write");
      await Promise.resolve();
    });
    const stale = latest.respondConfirm;
    mocks.confirmTool.mockReturnValueOnce(new Promise<void>(() => {}));
    act(() => { void latest.respondConfirm(true); });
    // in flight: a second answer, even a stale render's, is refused
    await act(() => stale(false));
    expect(mocks.confirmTool.mock.calls).toEqual([["conv1", "c1", true]]);
    expect(latest.pendingConfirm?.sentDecision).toBe(true);
  });

  // The server can finish the turn before the answer's POST returns; the
  // next turn's card must still take an answer.
  test("a turn that ends while an answer is in flight leaves the next answerable", async () => {
    mocks.createConversation.mockResolvedValue({ id: "conv1", model: "sonnet" });
    let release!: () => void;
    mocks.streamMessage.mockImplementationOnce(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent(confirmEvent("c1"));
        await new Promise<void>((r) => (release = r));
      },
    );
    mocks.streamMessage.mockImplementationOnce(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent(confirmEvent("c3"));
        await new Promise<void>(() => {});
      },
    );
    mocks.confirmTool.mockReturnValueOnce(new Promise<void>(() => {}));
    mocks.confirmTool.mockResolvedValueOnce(undefined);
    render(<Harness />);
    let first!: Promise<void>;
    await act(async () => {
      first = latest.send("please write");
      await Promise.resolve();
    });
    act(() => { void latest.respondConfirm(true); });
    await act(async () => {
      release();
      await first;
    });
    expect(latest.answering).toBe(false);
    await act(async () => {
      void latest.send("and again");
      await Promise.resolve();
    });
    expect(latest.pendingConfirm?.confirmId).toBe("c3");
    await act(() => latest.respondConfirm(true));
    expect(mocks.confirmTool).toHaveBeenLastCalledWith("conv1", "c3", true);
  });

  test("a reaped conversation drops the whole queue", async () => {
    mocks.createConversation.mockResolvedValue({ id: "conv1", model: "sonnet" });
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent(confirmEvent("c1"));
        onEvent(confirmEvent("c2"));
        await new Promise<void>(() => {});
      },
    );
    mocks.confirmTool.mockRejectedValue(
      new ApiError(404, "/api/assistant/conversations/conv1/confirm"));
    render(<Harness />);
    await act(async () => {
      void latest.send("please write");
      await Promise.resolve();
    });
    await act(() => latest.respondConfirm(true));
    expect(latest.pendingConfirm).toBeNull();
    expect(latest.pendingConfirmCount).toBe(0);
    expect(latest.status).toBe("idle");
    expect(latest.error).toMatch(/expired/);
  });

  // The phase drives the busy line's label and its elapsed clock.
  test("phase events update the label mid-turn; turn end clears it", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    let release!: () => void;
    const gate = () => new Promise<void>((r) => (release = r));
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent({ type: "phase", label: "reasoning" });
        await gate();
        onEvent({ type: "phase", label: "preparing save_note" });
        await gate();
        onEvent({ type: "turn_done", usage: null });
      },
    );
    render(<Harness />);
    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = latest.send("tidy this page");
      await Promise.resolve();
    });
    expect(latest.phase).toEqual({ label: "reasoning", since: expect.any(Number) as number });
    await act(async () => release());
    expect(latest.phase).toEqual({ label: "preparing save_note", since: expect.any(Number) as number });
    await act(async () => {
      release();
      await sendDone;
    });
    expect(latest.phase).toBeNull();
    expect(latest.status).toBe("idle");
  });

  test("send opens an unlabelled phase; tool_started resets back to it", async () => {
    // The pre-first-event window has no label by design (the busy line reads
    // plain "thinking…"), and a running tool's own line takes over from any
    // stale "preparing …" label.
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    let release!: () => void;
    const gate = () => new Promise<void>((r) => (release = r));
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        await gate();
        onEvent({ type: "phase", label: "preparing search" });
        await gate();
        onEvent({ type: "tool_started", tool_use_id: "t1", name: "search",
          summary: 'searching "x"' });
        await gate();
        onEvent({ type: "turn_done", usage: null });
      },
    );
    render(<Harness />);
    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = latest.send("find x");
      await Promise.resolve();
    });
    expect(latest.phase).toEqual({ label: null, since: expect.any(Number) as number });
    await act(async () => release());
    expect(latest.phase).toEqual({ label: "preparing search", since: expect.any(Number) as number });
    await act(async () => release());
    expect(latest.phase).toEqual({ label: null, since: expect.any(Number) as number });
    await act(async () => {
      release();
      await sendDone;
    });
    expect(latest.phase).toBeNull();
  });

  test("resuming from a confirm restarts the phase clock unlabelled", async () => {
    // The parked stretch was the user's silence, not the model's; its
    // duration must not leak into the next busy stretch's elapsed display.
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    let release!: () => void;
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent({ type: "phase", label: "preparing save_note" });
        onEvent(confirmEvent("t1"));
        await new Promise<void>((r) => (release = r));
        onEvent({ type: "turn_done", usage: null });
      },
    );
    mocks.confirmTool.mockResolvedValue(undefined);
    render(<Harness />);
    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = latest.send("please write");
      await Promise.resolve();
    });
    expect(latest.status).toBe("confirm");
    await act(async () => {
      await latest.respondConfirm(true);
    });
    expect(latest.status).toBe("busy");
    expect(latest.phase).toEqual({ label: null, since: expect.any(Number) as number });
    await act(async () => {
      release();
      await sendDone;
    });
    expect(latest.phase).toBeNull();
  });

  test("error event surfaces and unlocks", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    feed([{ type: "error", message: "boom" }]);
    render(<Harness />);
    await act(() => latest.send("hi"));
    expect(latest.error).toBe("boom");
    expect(latest.status).toBe("idle");
  });

  test("newChat deletes and resets", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.deleteConversation.mockResolvedValue(undefined);
    feed([{ type: "turn_done", usage: null }]);
    render(<Harness />);
    await act(() => latest.send("hi"));
    await act(() => latest.newChat());
    expect(mocks.deleteConversation).toHaveBeenCalledWith("c1");
    expect(latest.items).toEqual([]);
    expect(latest.modelLocked).toBe(false);
  });

  test("send failure surfaces error", async () => {
    mocks.createConversation.mockRejectedValue(new Error("cap reached"));
    render(<Harness />);
    await act(() => latest.send("hi"));
    expect(latest.error).toContain("cap reached");
    expect(latest.status).toBe("idle");
  });

  test("send retries once after a 404 (server reaped the conversation)", async () => {
    mocks.createConversation
      .mockResolvedValueOnce({ id: "c1", model: "sonnet" })
      .mockResolvedValueOnce({ id: "c2", model: "sonnet" });
    mocks.streamMessage
      .mockImplementationOnce(async () => {
        throw new ApiError(404, "/api/assistant/conversations/c1/messages");
      })
      .mockImplementationOnce(
        async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
          onEvent({ type: "text_delta", text: "hey" });
          onEvent({ type: "turn_done", usage: null });
        },
      );
    render(<Harness />);
    await act(() => latest.send("hi"));
    expect(mocks.createConversation).toHaveBeenCalledTimes(2);
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.streamMessage.mock.calls[1][0]).toBe("c2");
    expect(latest.error).toBeNull();
    expect(latest.items).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hey" },
    ]);
  });

  test("send retries at most once: a second 404 surfaces as an error", async () => {
    mocks.createConversation
      .mockResolvedValueOnce({ id: "c1", model: "sonnet" })
      .mockResolvedValueOnce({ id: "c2", model: "sonnet" });
    mocks.streamMessage.mockImplementation(async () => {
      throw new ApiError(404, "/api/assistant/conversations/x/messages", "unknown conversation");
    });
    render(<Harness />);
    await act(() => latest.send("hi"));
    expect(mocks.createConversation).toHaveBeenCalledTimes(2);
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
    expect(latest.error).toBe("unknown conversation");
    expect(latest.status).toBe("idle");
  });

  test("ApiError detail is surfaced as the error message, not the raw status", async () => {
    mocks.createConversation.mockRejectedValue(
      new ApiError(409, "/api/assistant/conversations", "at most 3 concurrent conversations"),
    );
    render(<Harness />);
    await act(() => latest.send("hi"));
    expect(latest.error).toBe("at most 3 concurrent conversations");
  });

  test("stop aborts the in-flight turn without surfacing an error", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    let capturedSignal: AbortSignal | undefined;
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, _onEvent: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const err = new DOMException("aborted", "AbortError");
            reject(err);
          });
        });
      },
    );
    render(<Harness />);
    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = latest.send("hi");
      await Promise.resolve();
    });
    expect(latest.status).toBe("busy");
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    await act(async () => {
      latest.stop();
      await sendDone;
    });
    expect(latest.status).toBe("idle");
    expect(latest.error).toBeNull();
  });

  test("stop then an immediate resend tolerates a transient 409 from the server catching up", async () => {
    // AbortController.abort() rejects the client's fetch promise
    // immediately, well before the server has processed the TCP
    // disconnect and released the conversation's busy flag. A
    // send() issued right after Stop can therefore land while the server
    // still thinks the previous turn is running; retry briefly instead of
    // surfacing a confusing "a turn is already in progress" error for a
    // condition that resolves itself in milliseconds.
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.streamMessage
      .mockImplementationOnce(async () => {
        throw new ApiError(409, "/api/assistant/conversations/c1/messages", "a turn is already in progress");
      })
      .mockImplementationOnce(
        async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
          onEvent({ type: "text_delta", text: "hey" });
          onEvent({ type: "turn_done", usage: null });
        },
      );
    render(<Harness />);
    await act(() => latest.send("hi"));
    expect(mocks.streamMessage).toHaveBeenCalledTimes(2);
    expect(mocks.createConversation).toHaveBeenCalledTimes(1); // no re-create, just a retry
    expect(latest.error).toBeNull();
    expect(latest.items).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hey" },
    ]);
  });

  test("a busy 409 that never clears still eventually surfaces as an error", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.streamMessage.mockImplementation(async () => {
      throw new ApiError(409, "/api/assistant/conversations/c1/messages", "a turn is already in progress");
    });
    render(<Harness />);
    await act(() => latest.send("hi"));
    expect(latest.error).toBe("a turn is already in progress");
    expect(latest.status).toBe("idle");
  });

  test("pagehide sends a beacon to close the live conversation", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    feed([{ type: "turn_done", usage: null }]);
    render(<Harness />);
    // no conversation yet: no-op
    window.dispatchEvent(new Event("pagehide"));
    expect(mocks.closeConversationBeacon).not.toHaveBeenCalled();
    await act(() => latest.send("hi"));
    window.dispatchEvent(new Event("pagehide"));
    expect(mocks.closeConversationBeacon).toHaveBeenCalledWith("c1");
  });

  test("tool_finished marks the line with its own id, carrying its error", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    feed([
      { type: "tool_started", tool_use_id: "t1", name: "update_block", summary: "update_block" },
      { type: "tool_started", tool_use_id: "t2", name: "update_block", summary: "update_block" },
      { type: "tool_finished", tool_use_id: "t2", name: "update_block",
        error: "nope", declined: false },
      { type: "turn_done", usage: null },
    ]);
    render(<Harness />);
    await act(() => latest.send("edit"));
    expect(latest.items).toEqual([
      { kind: "user", text: "edit" },
      { kind: "tool", toolUseId: "t1", name: "update_block", summary: "update_block",
        done: false, error: null, declined: false },
      { kind: "tool", toolUseId: "t2", name: "update_block", summary: "update_block",
        done: true, error: "nope", declined: false },
    ]);
  });

  test("a declined write's line is done, with no error", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    feed([
      { type: "tool_started", tool_use_id: "t1", name: "update_block", summary: "update_block" },
      { type: "tool_finished", tool_use_id: "t1", name: "update_block",
        error: null, declined: true },
      { type: "turn_done", usage: null },
    ]);
    render(<Harness />);
    await act(() => latest.send("edit"));
    expect(latest.items[1]).toEqual(
      { kind: "tool", toolUseId: "t1", name: "update_block", summary: "update_block",
        done: true, error: null, declined: true });
  });

  test("a later turn's tool_finished marks an earlier turn's line", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    feed([
      { type: "tool_started", tool_use_id: "t1", name: "update_block", summary: "update_block" },
      { type: "turn_done", usage: null },
    ]);
    render(<Harness />);
    await act(() => latest.send("one"));
    feed([
      { type: "tool_finished", tool_use_id: "t1", name: "update_block",
        error: "nope", declined: false },
      { type: "turn_done", usage: null },
    ]);
    await act(() => latest.send("two"));
    expect(latest.items[1]).toEqual(
      { kind: "tool", toolUseId: "t1", name: "update_block", summary: "update_block",
        done: true, error: "nope", declined: false });
  });

  test("newChat aborts the live turn; its late events never reach the new chat", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.deleteConversation.mockResolvedValue(undefined);
    let emit!: (ev: AssistantEvent) => void;
    let capturedSignal: AbortSignal | undefined;
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void,
             signal?: AbortSignal) => {
        emit = onEvent;
        capturedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")));
        });
      },
    );
    render(<Harness />);
    await act(async () => {
      void latest.send("hi");
      await Promise.resolve();
    });
    act(() => emit({ type: "text_delta", text: "half a repl" }));
    expect(latest.items).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "half a repl" },
    ]);
    expect(latest.status).toBe("busy");

    await act(() => latest.newChat());
    expect(capturedSignal?.aborted).toBe(true);
    expect(mocks.deleteConversation).toHaveBeenCalledWith("c1");
    expect(latest.items).toEqual([]);
    expect(latest.status).toBe("idle");
    expect(latest.error).toBeNull();
    expect(latest.modelLocked).toBe(false);

    // the superseded turn is still holding onEvent: nothing it emits now may
    // land in the fresh transcript
    act(() => {
      emit({ type: "text_delta", text: "y from the dead turn" });
      emit(confirmEvent("t9"));
      emit({ type: "error", message: "stale boom" });
    });
    expect(latest.items).toEqual([]);
    expect(latest.pendingConfirm).toBeNull();
    expect(latest.error).toBeNull();
    expect(latest.status).toBe("idle");
  });

  test("a superseded turn's abort is not reported as an error", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.deleteConversation.mockResolvedValue(undefined);
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, _onEvent: unknown,
             signal?: AbortSignal) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")));
        });
      },
    );
    render(<Harness />);
    await act(async () => {
      void latest.send("hi");
      await Promise.resolve();
    });
    // no latest.stop(): stopRequested stays false, so only the generation
    // guard can keep this abort out of `error`
    await act(() => latest.newChat());
    expect(latest.error).toBeNull();
    expect(latest.status).toBe("idle");
  });

  test("newChat keeps a newer turn's controller and stays stoppable", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.deleteConversation.mockResolvedValue(undefined);
    const signals: AbortSignal[] = [];
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, _onEvent: unknown,
             signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")));
        });
      },
    );
    render(<Harness />);
    await act(async () => {
      void latest.send("first");
      await Promise.resolve();
    });
    await act(() => latest.newChat());
    let secondDone!: Promise<void>;
    await act(async () => {
      secondDone = latest.send("second");
      await Promise.resolve();
    });
    expect(latest.status).toBe("busy");
    await act(async () => {
      latest.stop();
      await secondDone;
    });
    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(true);   // the newer turn really stopped
    expect(latest.status).toBe("idle");
    expect(latest.error).toBeNull();
  });

  test("a superseded turn's finally, settling only after the next turn has started, cannot clobber it", async () => {
    // newChat() awaits the superseded turn before it
    // resolves, so a test that awaits newChat() before starting the next
    // send() never actually overlaps the two turns -- by the time send()
    // runs, turn one's finally has already executed and its writes are
    // indistinguishable from a no-op. AssistantPanel calls
    // `void assistant.newChat()` (fire-and-forget), so in real usage a
    // second turn can start while newChat()'s internal await is still
    // pending. This test recreates that overlap directly: it holds turn
    // one's stream open past the point where turn two's controller is
    // installed, only then lets turn one's (already-aborted) fetch reject.
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.deleteConversation.mockResolvedValue(undefined);
    const turns: Array<{ signal?: AbortSignal; reject: (err: unknown) => void }> = [];
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, _onEvent: unknown, signal?: AbortSignal) => {
        const held = deferredValue<void>();
        turns.push({ signal, reject: held.reject });
        await held.promise;
      },
    );
    render(<Harness />);
    await act(async () => {
      void latest.send("first");
      await Promise.resolve();
    });
    expect(turns).toHaveLength(1);

    // Fire-and-forget, exactly like the panel's click -- do not await it, so
    // its internal `await inflight` is still pending when the next send() runs.
    let resetDone!: Promise<void>;
    act(() => { resetDone = latest.newChat(); });

    // A second turn starts while newChat() is still awaiting turn one.
    await act(async () => {
      void latest.send("second");
      await Promise.resolve();
    });
    expect(turns).toHaveLength(2);
    expect(latest.status).toBe("busy");

    // Only now does turn one's aborted fetch actually reject; its finally
    // (runTurn's controller cleanup, send's error/finally) runs with
    // generation two already current.
    await act(async () => {
      turns[0].reject(new DOMException("aborted", "AbortError"));
      await resetDone;
    });

    // Turn one's finalizers must not have reset turn two's busy status...
    expect(latest.status).toBe("busy");
    expect(latest.error).toBeNull();
    // ...nor discarded turn two's controller.
    latest.stop();
    expect(turns[1].signal?.aborted).toBe(true);
  });

  test("a conversation created by a superseded turn is closed, not adopted", async () => {
    const created = deferredValue<{ id: string; model: string }>();
    mocks.createConversation.mockReturnValue(created.promise);
    mocks.deleteConversation.mockResolvedValue(undefined);
    feed([{ type: "turn_done", usage: null }]);
    render(<Harness />);
    await act(async () => {
      void latest.send("hi");
      await Promise.resolve();
    });
    // the turn is still inside createConversation: there is no stream to abort
    // and no id to delete yet, and newChat must not block on it
    await act(() => latest.newChat());
    await act(async () => { created.resolve({ id: "c1", model: "sonnet" }); });
    await vi.waitFor(() =>
      expect(mocks.deleteConversation).toHaveBeenCalledWith("c1"));
    expect(mocks.streamMessage).not.toHaveBeenCalled();

    // the next send must create a fresh conversation, not reuse c1
    mocks.createConversation.mockReset();
    mocks.createConversation.mockResolvedValue({ id: "c2", model: "sonnet" });
    await act(() => latest.send("again"));
    expect(mocks.streamMessage.mock.calls[0][0]).toBe("c2");
  });

  test("newChat clears the transcript synchronously, as the panel's click does", async () => {
    // AssistantPanel's New chat button calls `void assistant.newChat()`,
    // so an empty chat must appear on the click -- not after the abort has
    // unwound and the DELETE has resolved.
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    const deletion = deferredValue<void>();
    mocks.deleteConversation.mockReturnValue(deletion.promise);
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void,
             signal?: AbortSignal) => {
        onEvent({ type: "text_delta", text: "partial" });
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")));
        });
      },
    );
    render(<Harness />);
    await act(async () => {
      void latest.send("hi");
      await Promise.resolve();
    });
    expect(latest.items).toHaveLength(2);

    let reset!: Promise<void>;
    act(() => { reset = latest.newChat(); });
    expect(latest.items).toEqual([]);       // before any await settles
    expect(latest.status).toBe("idle");
    expect(latest.modelLocked).toBe(false);

    await act(async () => {
      deletion.resolve();
      await reset;
    });
    expect(mocks.deleteConversation).toHaveBeenCalledWith("c1");
  });

  test("respondConfirm from a superseded turn cannot clobber the new chat", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.deleteConversation.mockResolvedValue(undefined);
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void,
             signal?: AbortSignal) => {
        onEvent(confirmEvent("t1"));
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")));
        });
      },
    );
    const confirmCall = deferredValue<void>();
    mocks.confirmTool.mockReturnValue(confirmCall.promise);
    render(<Harness />);
    await act(async () => {
      void latest.send("please write");
      await Promise.resolve();
    });
    expect(latest.status).toBe("confirm");

    let answering!: Promise<void>;
    act(() => { answering = latest.respondConfirm(true); });
    await act(() => latest.newChat());
    await act(async () => {
      confirmCall.reject(new ApiError(404, "/api/assistant/conversations/c1/confirm"));
      await answering;
    });
    // the 404 branch resets conversationId and sets an explanatory error;
    // neither may touch the chat that replaced it
    expect(latest.error).toBeNull();
    expect(latest.pendingConfirm).toBeNull();
    expect(latest.answering).toBe(false);
    expect(latest.status).toBe("idle");
  });
});
