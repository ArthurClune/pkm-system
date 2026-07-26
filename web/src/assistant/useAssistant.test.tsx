import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AssistantEvent } from "./sse";

const mocks = vi.hoisted(() => ({
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  confirmTool: vi.fn(),
  streamMessage: vi.fn(),
}));
vi.mock("./client", () => mocks);

import { useAssistant } from "./useAssistant";

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

describe("useAssistant", () => {
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
      { type: "tool_started", name: "search", summary: 'searching "x"' },
      { type: "tool_finished", name: "search" },
      { type: "text_delta", text: "found" },
      { type: "turn_done", usage: null },
    ]);
    render(<Harness />);
    await act(() => latest.send("find x"));
    expect(latest.items).toEqual([
      { kind: "user", text: "find x" },
      { kind: "tool", name: "search", summary: 'searching "x"', done: true },
      { kind: "assistant", text: "found" },
    ]);
  });

  test("confirm_request pauses, respondConfirm answers", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    let release!: () => void;
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent({ type: "confirm_request", tool_use_id: "t1", ops_preview: "save_note(...)" });
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
    expect(latest.pendingConfirm).toEqual({ toolUseId: "t1", opsPreview: "save_note(...)" });
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
        onEvent({ type: "confirm_request", tool_use_id: "t1", ops_preview: "save_note(...)" });
        await new Promise<void>(() => {}); // turn stays open awaiting the confirm decision
      },
    );
    mocks.confirmTool.mockRejectedValue(new Error("network down"));
    render(<Harness />);
    await act(async () => {
      latest.send("please write");
      await Promise.resolve();
    });
    expect(latest.pendingConfirm).toEqual({ toolUseId: "t1", opsPreview: "save_note(...)" });
    await act(() => latest.respondConfirm(true));
    expect(latest.pendingConfirm).toEqual({ toolUseId: "t1", opsPreview: "save_note(...)" });
    expect(latest.status).toBe("confirm");
    expect(latest.error).toBe("network down");
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

  test("tool_finished marks only the first pending tool item with that name", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    feed([
      { type: "tool_started", name: "search", summary: 'searching "foo"' },
      { type: "tool_started", name: "search", summary: 'searching "bar"' },
      { type: "tool_finished", name: "search" },
      { type: "turn_done", usage: null },
    ]);
    render(<Harness />);
    await act(() => latest.send("search"));
    expect(latest.items).toEqual([
      { kind: "user", text: "search" },
      { kind: "tool", name: "search", summary: 'searching "foo"', done: true },
      { kind: "tool", name: "search", summary: 'searching "bar"', done: false },
    ]);
  });
});
