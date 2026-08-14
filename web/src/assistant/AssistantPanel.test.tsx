import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { stubFetch } from "../test-helpers";
import type { ChatItem, PendingConfirm } from "./useAssistant";

const state = vi.hoisted(() => ({
  current: {
    items: [] as ChatItem[],
    status: "idle" as "idle" | "busy" | "confirm",
    error: null as string | null,
    model: "sonnet",
    setModel: vi.fn(),
    models: ["sonnet", "opus", "haiku"],
    modelLocked: false,
    pendingConfirm: null as PendingConfirm | null,
    send: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
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
  state.current.models = ["sonnet", "opus", "haiku"];
});

describe("AssistantPanel", () => {
  test("model picker renders exactly what the server offers", () => {
    state.current.models = ["sonnet", "opus", "haiku", "glm"];
    render(<AssistantPanel open onClose={() => {}} />);
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["sonnet", "opus", "haiku", "glm"]);
  });

  test("model picker hides glm when the server does not offer it", () => {
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.queryByRole("option", { name: "glm" })).toBeNull();
  });

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

  test("Stop button appears while busy and calls stop() (pkm-c98s item 3)", () => {
    state.current.status = "idle";
    const { rerender } = render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    state.current.status = "busy";
    rerender(<AssistantPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(state.current.stop).toHaveBeenCalled();
  });

  test("Stop button is not shown during a confirm pause", () => {
    state.current.status = "confirm";
    state.current.pendingConfirm = { toolUseId: "t1", opsPreview: "save_note(title=Demo)" };
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  test("long ops previews collapse with a Show full preview toggle (pkm-c98s item 6)", () => {
    const longPreview = `save_note(text=${"x".repeat(600)})`;
    state.current.status = "confirm";
    state.current.pendingConfirm = { toolUseId: "t1", opsPreview: longPreview };
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.queryByText(longPreview)).toBeNull(); // collapsed: not the full string
    const toggle = screen.getByRole("button", { name: /show full preview/i });
    fireEvent.click(toggle);
    expect(screen.getByText(longPreview)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show less/i })).toBeInTheDocument();
  });

  test("short ops previews render in full with no toggle", () => {
    state.current.status = "confirm";
    state.current.pendingConfirm = { toolUseId: "t1", opsPreview: "save_note(title=Demo)" };
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText("save_note(title=Demo)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show full preview/i })).toBeNull();
  });

  test("a ((uid)) block ref in an assistant reply resolves and becomes clickable (pkm-gdi5)", async () => {
    stubFetch([["/api/block-refs", {
      block_ref_texts: { chart1: { text: "the compute chart block", page_title: "Charts" } },
    }]]);
    state.current.items = [
      { kind: "assistant", text: "see ((chart1)) for details" },
    ];
    render(
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <AssistantPanel open onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText("((chart1))")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("the compute chart block")).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "the compute chart block" })).toBeInTheDocument();
  });

  test("the model select is styled as a field (pkm-0wg9)", () => {
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByLabelText(/model/i)).toHaveClass("input-control");
  });
});
