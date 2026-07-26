import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatItem, PendingConfirm } from "./useAssistant";

const state = vi.hoisted(() => ({
  current: {
    items: [] as ChatItem[],
    status: "idle" as "idle" | "busy" | "confirm",
    error: null as string | null,
    model: "sonnet",
    setModel: vi.fn(),
    modelLocked: false,
    pendingConfirm: null as PendingConfirm | null,
    send: vi.fn().mockResolvedValue(undefined),
    respondConfirm: vi.fn().mockResolvedValue(undefined),
    newChat: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("./useAssistant", () => ({ useAssistant: () => state.current }));

import { AssistantPanel } from "./AssistantPanel";

afterEach(() => {
  vi.clearAllMocks();
  state.current.items = [];
  state.current.status = "idle";
  state.current.error = null;
  state.current.modelLocked = false;
  state.current.pendingConfirm = null;
});

describe("AssistantPanel", () => {
  test("renders nothing when closed", () => {
    const { container } = render(<AssistantPanel open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders messages and tool lines", () => {
    state.current.items = [
      { kind: "user", text: "find x" },
      { kind: "tool", name: "search", summary: 'searching "x"', done: true },
      { kind: "assistant", text: "Found **it**" },
    ];
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText("find x")).toBeInTheDocument();
    expect(screen.getByText(/searching "x"/)).toBeInTheDocument();
    expect(screen.getByText("it")).toBeInTheDocument(); // bold rendered via InlineSegments
  });

  test("Enter sends, Shift+Enter does not", () => {
    render(<AssistantPanel open onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/ask about your notes/i);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(state.current.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(state.current.send).toHaveBeenCalledWith("hello");
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  test("confirm card wires Allow and Deny", () => {
    state.current.status = "confirm";
    state.current.pendingConfirm = { toolUseId: "t1", opsPreview: "save_note(title=Demo)" };
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText("save_note(title=Demo)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(state.current.respondConfirm).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(state.current.respondConfirm).toHaveBeenCalledWith(false);
  });

  test("model select locked after first message; New chat unlocks via hook", () => {
    state.current.modelLocked = true;
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByLabelText(/model/i)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(state.current.newChat).toHaveBeenCalled();
  });

  test("Escape inside panel closes it", () => {
    const onClose = vi.fn();
    render(<AssistantPanel open onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/ask about your notes/i), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  test("shows error line", () => {
    state.current.error = "cap reached";
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText(/cap reached/)).toBeInTheDocument();
  });
});
