import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { stubFetch, confirmIdOf } from "../test-helpers";
import type { ChatItem, PendingConfirm, PhaseInfo } from "./useAssistant";
import { parseWritePreview, type PreviewOp, type WritePreview } from "./writePreview";

const state = vi.hoisted(() => {
  const noConfirm = (): PendingConfirm | null => null;
  return {
    current: {
      items: [] as ChatItem[],
      status: "idle" as "idle" | "busy" | "confirm",
      phase: null as PhaseInfo | null,
      error: null as string | null,
      model: "sonnet",
      setModel: vi.fn(),
      models: ["sonnet", "opus", "haiku", "fable"],
      ensureModels: vi.fn(),
      modelLocked: false,
      pendingConfirm: noConfirm(),
      pendingConfirmCount: 0,
      answering: false,
      send: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      respondConfirm: vi.fn().mockResolvedValue(undefined),
      newChat: vi.fn().mockResolvedValue(undefined),
    },
  };
});
vi.mock("./useAssistant", () => ({ useAssistant: () => state.current }));

import { AssistantPanel } from "./AssistantPanel";

afterEach(() => {
  vi.useRealTimers(); // a failed fake-timer test must not poison later ones
  vi.clearAllMocks();
  state.current.items = [];
  state.current.status = "idle";
  state.current.phase = null;
  state.current.error = null;
  state.current.modelLocked = false;
  state.current.pendingConfirm = null;
  state.current.pendingConfirmCount = 0;
  state.current.answering = false;
  state.current.models = ["sonnet", "opus", "haiku", "fable"];
});

function op(overrides: Partial<PreviewOp> = {}): PreviewOp {
  return { action: "update block", targets: [["uid", "VICTIMUID01"]],
    content: [["text", "Tidied wording.", 15]], warnings: [], ...overrides };
}

function previewOf(...ops: PreviewOp[]): WritePreview {
  return { ops, summary: "s" };
}

function showConfirm(preview: WritePreview | null, count = 1) {
  state.current.status = "confirm";
  state.current.pendingConfirm = {
    confirmId: confirmIdOf("t1"), opsPreview: "s", preview };
  state.current.pendingConfirmCount = count;
}

// the card's Allow arms after a pause, so a test that clicks it waits it out
function renderArmed() {
  vi.useFakeTimers();
  const view = render(<AssistantPanel open onClose={() => {}} />);
  act(() => { vi.advanceTimersByTime(600); });
  return view;
}

const card = () =>
  document.querySelector(".assistant-confirm-card") as HTMLElement;

describe("AssistantPanel", () => {
  test("model picker renders exactly what the server offers", () => {
    state.current.models = ["sonnet", "opus", "haiku", "fable", "glm"];
    render(<AssistantPanel open onClose={() => {}} />);
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["sonnet", "opus", "haiku", "fable", "glm"]);
  });

  test("model picker hides glm when the server does not offer it", () => {
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.queryByRole("option", { name: "glm" })).toBeNull();
  });

  test("opening the panel requests the model list; staying closed does not", () => {
    const { rerender } = render(<AssistantPanel open={false} onClose={() => {}} />);
    expect(state.current.ensureModels).not.toHaveBeenCalled();
    rerender(<AssistantPanel open onClose={() => {}} />);
    expect(state.current.ensureModels).toHaveBeenCalled();
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

  // The busy line answers "is it stuck?" -- phase label plus an
  // elapsed clock that visibly ticks.
  test("busy line shows the phase label and a ticking elapsed clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    state.current.status = "busy";
    state.current.phase = { label: "reasoning", since: 995_000 };
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText("reasoning… 5s")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(screen.getByText("reasoning… 8s")).toBeInTheDocument();
    vi.useRealTimers();
  });

  test("busy line falls back to thinking… before the first phase event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    state.current.status = "busy";
    state.current.phase = { label: null, since: 935_000 };
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText("thinking… 1m 5s")).toBeInTheDocument();
    vi.useRealTimers();
  });

  test("busy line renders plain thinking… with no phase info at all", () => {
    state.current.status = "busy";
    state.current.phase = null;
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText("thinking…")).toBeInTheDocument();
  });

  test("Stop button appears while busy and calls stop()", () => {
    state.current.status = "idle";
    const { rerender } = render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    state.current.status = "busy";
    rerender(<AssistantPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(state.current.stop).toHaveBeenCalled();
  });

  test("Stop button is not shown during a confirm pause", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  test("a ((uid)) block ref in an assistant reply resolves and becomes clickable", async () => {
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

  function LocationProbe() {
    return <span data-testid="location">{useLocation().pathname}</span>;
  }

  test("a reply's media waits for a click, including inside a resolved ((ref))", async () => {
    const fetchMock = stubFetch([["/api/block-refs", {
      block_ref_texts: {
        chart1: {
          text: "https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy",
          page_title: "Charts",
        },
      },
    }]]);
    state.current.items = [
      { kind: "assistant", text: "see ((chart1)) and ![x](https://attacker.invalid/a.png)" },
    ];
    render(
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <AssistantPanel open onClose={() => {}} />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "image from attacker.invalid: x" }))
      .toBeInTheDocument();
    const post = await screen.findByRole("button", { name: "Bluesky post from alice.bsky.social" });
    expect(document.querySelector("img, iframe")).toBeNull();
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes("public.api.bsky.app"))).toBe(false);

    // the load click must not reach the ((ref)) link around it
    const before = screen.getByTestId("location").textContent;
    fireEvent.click(post);
    expect(screen.getByTestId("location").textContent).toBe(before);
    await waitFor(() => {
      const after = fetchMock.mock.calls.map(([input]) => String(input));
      expect(after.some((url) => url.includes("public.api.bsky.app"))).toBe(true);
    });
  });

  test("a ((^uid)) citation with a copied caret marker still resolves", async () => {
    stubFetch([["/api/block-refs", {
      block_ref_texts: { chart1: { text: "the compute chart block", page_title: "Charts" } },
    }]]);
    state.current.items = [
      { kind: "assistant", text: "see ((^chart1)) for details" },
    ];
    render(
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <AssistantPanel open onClose={() => {}} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText("the compute chart block")).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "the compute chart block" })).toBeInTheDocument();
  });

  test("the model select is styled as a field", () => {
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByLabelText(/model/i)).toHaveClass("input-control");
  });
});

describe("ConfirmCard", () => {
  test("Allow answers true", () => {
    showConfirm(previewOf(op()));
    renderArmed();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(state.current.respondConfirm).toHaveBeenCalledWith(true);
  });

  test("Deny answers false", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(state.current.respondConfirm).toHaveBeenCalledWith(false);
  });

  test("the heading counts the writes", () => {
    showConfirm(previewOf(op(), op({ action: "rename page" })));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-title"))
      .toHaveTextContent(/^The assistant wants to make 2 writes:$/);
    expect(card().querySelectorAll("li.assistant-confirm-op")).toHaveLength(2);
  });

  test("one write is singular", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-title"))
      .toHaveTextContent(/^The assistant wants to make 1 write:$/);
  });

  test("targets render before content and are never clipped", () => {
    const longText = "Tidied wording. ".repeat(320).slice(0, 5000);
    showConfirm(previewOf(op({ content: [["text", longText, 5000]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const target = [...card().querySelectorAll(".assistant-confirm-target")]
      .find((el) => el.textContent?.includes("VICTIMUID01"));
    const content = card().querySelector(".assistant-confirm-content");
    expect(target).toBeDefined();
    expect(content).not.toBeNull();
    expect(target!.compareDocumentPosition(content!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(target!.textContent).toBe('uid: "VICTIMUID01"');
    // the long text is the part that is clipped
    expect(content!.textContent).not.toContain(longText);
  });

  test("a quoted value cannot read as another argument", () => {
    const text = 'x"\n2 delete block uid "Y"';
    showConfirm(previewOf(op({ content: [["text", text, text.length]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const contents = card().querySelectorAll(".assistant-confirm-content");
    expect(contents).toHaveLength(1);
    const value = contents[0].querySelector(".assistant-confirm-value")!;
    expect(value.textContent).toBe('"x\\"\n2 delete block uid \\"Y\\""');
    expect(value.textContent!.startsWith('"')).toBe(true);
    expect(value.textContent!.endsWith('"')).toBe(true);
  });

  test("a long value shows its length and is clipped outside the quote", () => {
    showConfirm(previewOf(op({ content: [["text", "a".repeat(500), 500]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const content = card().querySelector(".assistant-confirm-content")!;
    expect(content.querySelector(".assistant-confirm-value")!.textContent)
      .toBe('"' + "a".repeat(280) + '"…');
    expect(content).toHaveTextContent("(500 chars)");
  });

  test("show reveals the full content", () => {
    const longText = "b".repeat(279) + "TAIL" + "c".repeat(300);
    showConfirm(previewOf(
      op({ content: [["text", longText, longText.length]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card()).not.toHaveTextContent("TAIL");
    fireEvent.click(screen.getByRole("button", { name: "[show]" }));
    expect(card()
      .querySelector(".assistant-confirm-content .assistant-confirm-value")!
      .textContent).toBe(`"${longText}"`);
    expect(card()).not.toHaveTextContent("clipped by the server");
    fireEvent.click(screen.getByRole("button", { name: "[hide]" }));
    expect(card()).not.toHaveTextContent("TAIL");
  });

  test("a value the server clipped says so once shown in full", () => {
    const sent = "d".repeat(2000);
    showConfirm(previewOf(op({ content: [["text", sent, 5000]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "[show]" }));
    const content = card().querySelector(".assistant-confirm-content")!;
    expect(content.querySelector(".assistant-confirm-value")!.textContent)
      .toBe(`"${sent}"…`);
    expect(content).toHaveTextContent("(5000 chars)");
    expect(content).toHaveTextContent("clipped by the server at 2000");
  });

  // total_len counts code points; .length would count each emoji twice
  test("the clip and the length compare code points", () => {
    const emoji = "😀".repeat(280);
    showConfirm(previewOf(op({ content: [["text", emoji, 280]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const content = card().querySelector(".assistant-confirm-content")!;
    expect(content.querySelector(".assistant-confirm-value")!.textContent)
      .toBe(`"${emoji}"`);
    expect(content).not.toHaveTextContent("chars)");
    expect(screen.queryByRole("button", { name: "[show]" })).toBeNull();
  });

  test("a clip never splits an astral character", () => {
    const emoji = "😀".repeat(300);
    showConfirm(previewOf(op({ content: [["text", emoji, 300]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card()
      .querySelector(".assistant-confirm-content .assistant-confirm-value")!
      .textContent).toBe('"' + "😀".repeat(280) + '"…');
  });

  test("targets show in order with their values formatted", () => {
    showConfirm(previewOf(op({ action: "save note",
      targets: [["page", null], ["parent", "P1"], ["todo", false]],
      content: [] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const rows = [...card().querySelectorAll(".assistant-confirm-target")]
      .map((el) => el.textContent);
    expect(rows).toEqual(
      ["page: today's daily note", 'parent: "P1"', "todo: false"]);
    expect(card().querySelector(".assistant-confirm-action"))
      .toHaveTextContent(/^save note$/);
  });

  test("keys render in the key style, followed by a colon", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    const key = card()
      .querySelector(".assistant-confirm-target .assistant-confirm-key")!;
    expect(key.textContent).toBe("uid");
    expect(key.nextSibling?.textContent).toBe(": ");
    const contentKey = card()
      .querySelector(".assistant-confirm-content .assistant-confirm-key")!;
    expect(contentKey.textContent).toBe("text");
    expect(contentKey.nextSibling?.textContent).toBe(": ");
  });

  test("every value is bidi-isolated", () => {
    showConfirm(previewOf(
      op({ targets: [["uid", "אב"], ["page", "P"]] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const values = card().querySelectorAll(".assistant-confirm-value");
    expect(values).toHaveLength(3);
    for (const value of values) expect(value.tagName).toBe("BDI");
  });

  // what the server sends, through the parser the SSE stream uses
  const parsedPreview = (op: unknown) =>
    parseWritePreview({ ops: [op], summary: "s" });

  // the server JSON-quotes a title inside a warning; the card must show its
  // escape as sent, not double it into a quote that seems to close early
  test("a warning shows a quoted title exactly as the server escaped it", () => {
    const warning = `allow_merge is on: if ${JSON.stringify('a"b, c')} exists`;
    showConfirm(parsedPreview({ action: "rename page",
      targets: [["allow_merge", true]], content: [], warnings: [warning] }));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-warning")!.textContent)
      .toBe('⚠ allow_merge is on: if "a\\"b, c" exists');
  });

  // a key spelling out an escape must not pass for one the card made
  test("a key with a literal backslash-u shows the backslash doubled", () => {
    showConfirm(parsedPreview({ action: "save note",
      targets: [["x\\u202E", 1], ["y‮", 2]], content: [], warnings: [] }));
    render(<AssistantPanel open onClose={() => {}} />);
    const keys = [...card().querySelectorAll(".assistant-confirm-key")]
      .map((el) => el.textContent);
    expect(keys).toEqual(["x\\\\u202E", "y\\u202E"]);
  });

  test("warnings show after the targets, marked", () => {
    showConfirm(previewOf(op({ action: "rename page",
      targets: [["title", "Inbox"], ["allow_merge", true]], content: [],
      warnings: ['allow_merge is on: "Inbox" is merged into it'] })));
    render(<AssistantPanel open onClose={() => {}} />);
    const warning = card().querySelector(".assistant-confirm-warning")!;
    expect(warning)
      .toHaveTextContent('⚠ allow_merge is on: "Inbox" is merged into it');
    const lastTarget =
      [...card().querySelectorAll(".assistant-confirm-target")].at(-1)!;
    expect(lastTarget.compareDocumentPosition(warning)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("the buttons sit outside the scrolling ops list", () => {
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    const ops = card().querySelector("ol.assistant-confirm-ops")!;
    expect(ops.contains(screen.getByRole("button", { name: "Deny" })))
      .toBe(false);
  });

  test("malformed preview offers only Deny", () => {
    showConfirm(null);
    renderArmed();
    expect(card()).toHaveTextContent("The write preview could not be read.");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(state.current.respondConfirm).toHaveBeenCalledWith(false);
  });

  test("shows the queue position", () => {
    showConfirm(previewOf(op()), 2);
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-title"))
      .toHaveTextContent(/^The assistant wants to make 1 write \(1 of 2\):$/);
  });

  test("the queue position pluralises by the head's writes", () => {
    showConfirm(previewOf(op(), op()), 3);
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-title"))
      .toHaveTextContent(/^The assistant wants to make 2 writes \(1 of 3\):$/);
  });

  test("an unreadable preview still shows its queue position", () => {
    showConfirm(null, 2);
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card().querySelector(".assistant-confirm-title"))
      .toHaveTextContent(/^The assistant wants to write \(1 of 2\):$/);
  });

  test("a lone confirm shows no queue position", () => {
    showConfirm(previewOf(op()), 1);
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card()).not.toHaveTextContent(/1 of/);
  });

  // a double-click aimed at the previous control must not land on Allow
  test("Allow arms after a pause; Deny is live at once", () => {
    vi.useFakeTimers();
    showConfirm(previewOf(op()));
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(state.current.respondConfirm).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  test("the next card in the queue arms afresh", () => {
    showConfirm(previewOf(op()), 2);
    const { rerender } = renderArmed();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    state.current.pendingConfirm = {
      confirmId: confirmIdOf("t2"), opsPreview: "s", preview: previewOf(op()) };
    state.current.pendingConfirmCount = 1;
    rerender(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
  });

  test("while answering both buttons are disabled and Stop shows", () => {
    showConfirm(previewOf(op()));
    state.current.answering = true;
    renderArmed();
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(state.current.stop).toHaveBeenCalled();
  });

  // the server may hold the first answer already and ignores a changed one,
  // so a failed answer can only be sent again as it was
  test.each([
    ["Allow", true],
    ["Deny", false],
  ] as const)("a failed %s offers only a retry of it", (name, allow) => {
    showConfirm(previewOf(op()));
    const { rerender } = renderArmed();
    fireEvent.click(screen.getByRole("button", { name }));
    state.current.answering = true;
    rerender(<AssistantPanel open onClose={() => {}} />);
    state.current.answering = false;
    state.current.error = "request failed";
    rerender(<AssistantPanel open onClose={() => {}} />);
    const buttons = within(card()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([`Retry ${name}`]);
    fireEvent.click(buttons[0]);
    expect(state.current.respondConfirm).toHaveBeenNthCalledWith(2, allow);
  });
});

// jsdom has no layout and no IntersectionObserver: these stand in for an ops
// list taller than its scroll region and for the browser's visibility reports
function overflowOpsList() {
  const spy = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(1000);
  onTestFinished(() => spy.mockRestore());
}

type Observed = {
  callback: IntersectionObserverCallback;
  root: Element | Document | null | undefined;
  targets: Element[];
};

function mockIntersectionObserver(): Observed[] {
  const made: Observed[] = [];
  class FakeObserver {
    private record: Observed;
    constructor(callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit) {
      this.record = { callback, root: options?.root, targets: [] };
      made.push(this.record);
    }
    observe(target: Element) { this.record.targets.push(target); }
    disconnect() { this.record.targets = []; }
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  return made;
}

function report(observed: Observed, isIntersecting: boolean) {
  const target = observed.targets[0];
  act(() => {
    observed.callback(
      [{ isIntersecting, target } as IntersectionObserverEntry],
      {} as IntersectionObserver);
  });
}

describe("ConfirmCard: the end of the list arms Allow", () => {
  const allow = () => screen.getByRole("button", { name: "Allow" });
  const hint = "Scroll to the end to review every write";

  test("an overflowing list keeps Allow off until its end is seen", () => {
    overflowOpsList();
    const made = mockIntersectionObserver();
    showConfirm(previewOf(op(), op({ action: "rename page" })));
    renderArmed();
    expect(allow()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    expect(card()).toHaveTextContent(hint);
    // the observer watches a marker after the last op, inside the list
    expect(made).toHaveLength(1);
    const list = card().querySelector("ol.assistant-confirm-ops")!;
    expect(made[0].root).toBe(list);
    const lastOp = [...list.querySelectorAll("li.assistant-confirm-op")].at(-1)!;
    expect(lastOp.compareDocumentPosition(made[0].targets[0])
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    report(made[0], false);
    expect(allow()).toBeDisabled();
    report(made[0], true);
    expect(allow()).toBeEnabled();
    expect(card()).not.toHaveTextContent(hint);
  });

  test("an end seen before the pause still waits out the pause", () => {
    overflowOpsList();
    const made = mockIntersectionObserver();
    showConfirm(previewOf(op()));
    vi.useFakeTimers();
    render(<AssistantPanel open onClose={() => {}} />);
    report(made[0], true);
    expect(card()).not.toHaveTextContent(hint);
    expect(allow()).toBeDisabled();
    act(() => { vi.advanceTimersByTime(600); });
    expect(allow()).toBeEnabled();
  });

  test("once seen, the end stays seen", () => {
    overflowOpsList();
    const made = mockIntersectionObserver();
    showConfirm(previewOf(op()));
    renderArmed();
    report(made[0], true);
    expect(allow()).toBeEnabled();
    expect(made[0].targets).toEqual([]); // no longer watched
  });

  test("a list that does not overflow counts as seen at once", () => {
    const made = mockIntersectionObserver();
    showConfirm(previewOf(op()));
    vi.useFakeTimers();
    render(<AssistantPanel open onClose={() => {}} />);
    expect(card()).not.toHaveTextContent(hint);
    expect(allow()).toBeDisabled();
    act(() => { vi.advanceTimersByTime(600); });
    expect(allow()).toBeEnabled();
    expect(made).toHaveLength(0);
  });

  test("without an observer an overflowing list never arms Allow", () => {
    overflowOpsList();
    vi.stubGlobal("IntersectionObserver", undefined);
    onTestFinished(() => { vi.unstubAllGlobals(); });
    showConfirm(previewOf(op()));
    renderArmed();
    expect(allow()).toBeDisabled();
    expect(card()).toHaveTextContent(hint);
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });
});
